// Audition per-file audio offsets in IINA at the video’s nominal frame rate.
import AppKit
import Darwin
import Foundation

private let frameRange = -12...12

private struct PlayerError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

private final class IPC {
  private let fd: Int32
  private var buffer = Data()
  private var sequence = 0

  init(_ url: URL) throws {
    var address = sockaddr_un()
    let bytes = Array(url.path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
      throw PlayerError("播放器连接路径过长。")
    }
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw PlayerError("无法建立本机连接。") }
    fd = descriptor
    var one: Int32 = 1
    var timeout = timeval(tv_sec: 1, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    address.sun_family = sa_family_t(AF_UNIX)
    let length = socklen_t(2 + bytes.count)
    address.sun_len = UInt8(length)
    withUnsafeMutableBytes(of: &address.sun_path) { dest in
      bytes.withUnsafeBytes { dest.copyMemory(from: $0) }
    }
    let connected = withUnsafePointer(to: &address) { ptr in
      ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(descriptor, $0, length)
      }
    }
    guard connected == 0 else {
      Darwin.close(descriptor)
      throw PlayerError("请打开校准影片。")
    }
  }

  deinit { Darwin.close(fd) }

  @discardableResult
  func run(_ command: [Any]) throws -> Any? {
    sequence += 1
    var data = try JSONSerialization.data(withJSONObject: [
      "command": command, "request_id": sequence,
    ])
    data.append(0x0a)
    try data.withUnsafeBytes { raw in
      var sent = 0
      while sent < raw.count {
        let n = Darwin.send(fd, raw.baseAddress!.advanced(by: sent), raw.count - sent, 0)
        if n < 0 && errno == EINTR { continue }
        guard n > 0 else { throw PlayerError("播放器连接已中断。") }
        sent += n
      }
    }
    while true {
      if let newline = buffer.firstIndex(of: 0x0a) {
        let line = Data(buffer[..<newline])
        buffer.removeSubrange(...newline)
        guard let reply = try JSONSerialization.jsonObject(with: line) as? [String: Any],
          reply["request_id"] as? Int == sequence
        else { continue }
        guard reply["error"] as? String == "success" else {
          throw PlayerError("播放器暂时无法执行这个操作。")
        }
        return reply["data"]
      }
      var chunk = [UInt8](repeating: 0, count: 4096)
      let n = chunk.withUnsafeMutableBytes { Darwin.recv(fd, $0.baseAddress!, $0.count, 0) }
      if n < 0 && errno == EINTR { continue }
      guard n > 0 else { throw PlayerError("播放器未响应，请重新打开影片。") }
      buffer.append(contentsOf: chunk.prefix(n))
    }
  }
}

private final class Player {
  let movie: URL
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "MusicMarblesStudio.frame-tuner")
  var endpoint: URL
  let defaults = UserDefaults.standard

  init(movie: URL) {
    self.movie = movie.standardizedFileURL.resolvingSymlinksInPath()
    let token = defaults.string(forKey: "socketToken").flatMap(UUID.init(uuidString:)) ?? UUID()
    endpoint = directory.appendingPathComponent(String(token.uuidString.prefix(8)) + ".sock")
  }

  func connection() throws -> IPC {
    let ipc = try IPC(endpoint)
    let name = try ipc.run(["get_property", "path"]) as? String
    guard let name,
      URL(fileURLWithPath: name).standardizedFileURL.resolvingSymlinksInPath().path == movie.path
    else {
      throw PlayerError("当前 IINA 窗口已换片，请重新打开校准影片。")
    }
    return ipc
  }

  func open(replacing previous: Player?) throws -> IPC {
    if let live = try? connection() { return live }
    guard FileManager.default.fileExists(atPath: movie.path) else {
      throw PlayerError("找不到选定的影片，请重新选择。")
    }
    if let previous, previous.movie != movie, let live = try? previous.connection() {
      endpoint = previous.endpoint
      try live.run(["loadfile", movie.path, "replace"])
    } else {
      guard
        let iina = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.colliderli.iina")
      else { throw PlayerError("未找到 IINA 播放器。") }
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      let token = UUID()
      endpoint = directory.appendingPathComponent(String(token.uuidString.prefix(8)) + ".sock")
      let opener = Process()
      opener.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      opener.arguments = [
        "-n", "-a", iina.path, "--args", "--no-stdin",
        "--mpv-input-ipc-server=" + endpoint.path, "--mpv-resume-playback=no",
        "--mpv-start=0", "--mpv-keep-open=yes", "--mpv-pause=yes", "--mpv-speed=1", movie.path,
      ]
      try opener.run()
      opener.waitUntilExit()
      guard opener.terminationStatus == 0 else { throw PlayerError("IINA 启动失败。") }
      defaults.set(token.uuidString, forKey: "socketToken")
    }
    let deadline = Date().addingTimeInterval(18)
    while Date() < deadline {
      // mpv exposes the path before IINA has finished opening the movie.
      // Wait for audio and video to be usable before sending the exact seek.
      if let live = try? connection(),
        (try? live.run(["get_property", "vo-configured"])) as? Bool == true,
        (try? live.run(["get_property", "seekable"])) as? Bool == true,
        (try? live.run(["get_property", "audio-params"])) is [String: Any]
      {
        do {
          try live.run(["set_property", "pause", true])
          return live
        } catch {
          // A file-loaded transition may briefly invalidate a command.
        }
      }
      Thread.sleep(forTimeInterval: 0.12)
    }
    throw PlayerError("IINA 尚未就绪，请再点一次「打开影片」。")
  }

  func setOffset(_ ipc: IPC, frames: Int, fps: Double) throws {
    let seconds = Double(frames) / fps
    try ipc.run(["set_property", "audio-delay", seconds])
    guard let actual = try ipc.run(["get_property", "audio-delay"]) as? Double,
      abs(actual - seconds) < 0.00051
    else { throw PlayerError("声音偏移未生效。") }
  }

  func loop(_ ipc: IPC, enabled: Bool) throws {
    if enabled {
      guard let position = try ipc.run(["get_property", "time-pos"]) as? Double,
        let duration = try ipc.run(["get_property", "duration"]) as? Double,
        duration.isFinite && duration > 0
      else { throw PlayerError("无法读取当前播放位置与时长。") }
      let clipStart = min(max(0, position), max(0, duration - 5))
      let clipEnd = min(clipStart + 5, duration)
      try ipc.run(["set_property", "ab-loop-a", clipStart])
      do {
        try ipc.run(["set_property", "ab-loop-b", clipEnd])
        try ipc.run(["seek", clipStart, "absolute+exact"])
      } catch {
        _ = try? ipc.run(["set_property", "ab-loop-a", "no"])
        _ = try? ipc.run(["set_property", "ab-loop-b", "no"])
        throw error
      }
    } else {
      try ipc.run(["set_property", "ab-loop-a", "no"])
      try ipc.run(["set_property", "ab-loop-b", "no"])
    }
  }
}

private final class Controller: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let queue = DispatchQueue(label: "MusicMarbles.IINA")
  var player: Player?
  var previousPlayer: Player?
  var fps: Double?
  let track = NSTextField(labelWithString: "请选择影片")
  var picker: NSButton!
  var panel: NSPanel!
  let slider = NSSlider(value: 0, minValue: -12, maxValue: 12, target: nil, action: nil)
  let readout = NSTextField(labelWithString: "")
  let millis = NSTextField(labelWithString: "")
  let status = NSTextField(labelWithString: "")
  let loop = NSButton(checkboxWithTitle: "从当前位置循环 5 秒", target: nil, action: nil)
  var retry: NSButton!
  var buttons = [NSButton]()
  var pending: DispatchWorkItem?
  var keyMonitor: Any?
  var generation = 0
  var frames = 0
  var connected = false
  let normalStatus = "点选此面板后，按 ← 或 → 调整一帧。"

  func applicationDidFinishLaunching(_ notification: Notification) {
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 424, height: 320),
      styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    panel.title = "音画逐帧校准"
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.delegate = self
    panel.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
    let root = NSStackView()
    root.orientation = .vertical
    root.alignment = .leading
    root.spacing = 11
    let content = panel.contentView!
    content.addSubview(root)
    root.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      root.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22),
      root.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -22),
      root.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
    ])
    picker = NSButton(title: "选择影片…", target: self, action: #selector(chooseMovie))
    track.lineBreakMode = .byTruncatingMiddle
    track.font = .systemFont(ofSize: 13, weight: .medium)
    track.textColor = .secondaryLabelColor
    row([track, NSView(), picker], root)
    readout.font = .systemFont(ofSize: 26, weight: .semibold)
    millis.font = .monospacedDigitSystemFont(ofSize: 17, weight: .medium)
    millis.textColor = .secondaryLabelColor
    row([readout, NSView(), millis], root)
    slider.target = self
    slider.action = #selector(slide)
    slider.isContinuous = true
    slider.numberOfTickMarks = 25
    slider.allowsTickMarkValuesOnly = true
    slider.setAccessibilityLabel("声音偏移，单位为帧")
    slider.toolTip = "左侧提前声音，右侧延后声音；每格 1 帧"
    root.addArrangedSubview(slider)
    slider.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
    let captions = ["提前 12 帧", "原位", "延后 12 帧"].map { text -> NSTextField in
      let l = NSTextField(labelWithString: text)
      l.font = .systemFont(ofSize: 11)
      l.textColor = .secondaryLabelColor
      return l
    }
    let legend = NSView()
    root.addArrangedSubview(legend)
    for label in captions {
      legend.addSubview(label)
      label.translatesAutoresizingMaskIntoConstraints = false
      label.centerYAnchor.constraint(equalTo: legend.centerYAnchor).isActive = true
    }
    NSLayoutConstraint.activate([
      legend.widthAnchor.constraint(equalTo: root.widthAnchor),
      legend.heightAnchor.constraint(equalToConstant: 16),
      captions[0].leadingAnchor.constraint(equalTo: legend.leadingAnchor),
      captions[1].centerXAnchor.constraint(equalTo: legend.centerXAnchor),
      captions[2].trailingAnchor.constraint(equalTo: legend.trailingAnchor),
    ])
    row(
      [
        button("−1 帧", #selector(minus)), button("+1 帧", #selector(plus)), NSView(),
        button("归零", #selector(zero)),
      ], root)
    let line = NSBox()
    line.boxType = .separator
    root.addArrangedSubview(line)
    line.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
    loop.target = self
    loop.action = #selector(toggleLoop)
    root.addArrangedSubview(loop)
    retry = NSButton(title: "打开影片", target: self, action: #selector(connect))
    row([button("播放 / 暂停", #selector(playPause)), NSView(), retry], root)
    status.font = .systemFont(ofSize: 12)
    status.textColor = .secondaryLabelColor
    status.lineBreakMode = .byWordWrapping
    status.maximumNumberOfLines = 2
    root.addArrangedSubview(status)
    status.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
    let height = ceil(root.fittingSize.height) + 38
    panel.setContentSize(NSSize(width: 424, height: max(294, height)))
    if !panel.setFrameUsingName("FrameTuner") {
      let screen = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
      panel.setFrameTopLeftPoint(
        NSPoint(x: screen.maxX - panel.frame.width - 20, y: screen.maxY - 35))
    }
    panel.setFrameAutosaveName("FrameTuner")
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self, self.panel.isKeyWindow, self.connected,
        event.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty
      else { return event }
      if event.keyCode == 123 || event.keyCode == 124 {
        self.adjust(self.frames + (event.keyCode == 123 ? -1 : 1))
        return nil
      }
      return event
    }
    updateLabel()
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    if let path = UserDefaults.standard.string(forKey: "lastMovie"),
      FileManager.default.fileExists(atPath: path)
    {
      useMovie(URL(fileURLWithPath: path))
    } else {
      enable(false)
      retry.isHidden = true
      status.stringValue = "请选择有声视频。首次试听从零偏移开始。"
      chooseMovie()
    }
  }

  @objc func chooseMovie() {
    let dialog = NSOpenPanel()
    dialog.title = "选择校准影片"
    dialog.canChooseDirectories = false
    dialog.allowsMultipleSelection = false
    if let movie = player?.movie { dialog.directoryURL = movie.deletingLastPathComponent() }
    if dialog.runModal() == .OK, let url = dialog.url { useMovie(url) }
  }
  func useMovie(_ url: URL) {
    pending?.cancel()
    generation += 1
    previousPlayer = player
    let selected = Player(movie: url)
    player = selected
    fps = nil
    let saved =
      UserDefaults.standard.dictionary(forKey: "fileOffsets")?[selected.movie.path] as? Int ?? 0
    frames = min(frameRange.upperBound, max(frameRange.lowerBound, saved))
    track.stringValue = selected.movie.lastPathComponent
    track.toolTip = selected.movie.path
    UserDefaults.standard.set(selected.movie.path, forKey: "lastMovie")
    updateLabel()
    connect()
  }

  func button(_ title: String, _ action: Selector) -> NSButton {
    let b = NSButton(title: title, target: self, action: action)
    buttons.append(b)
    return b
  }
  func row(_ views: [NSView], _ parent: NSStackView) {
    let r = NSStackView(views: views)
    r.orientation = .horizontal
    r.alignment = .centerY
    r.distribution = .fill
    r.spacing = 7
    for v in views where type(of: v) == NSView.self {
      v.setContentHuggingPriority(.defaultLow, for: .horizontal)
    }
    parent.addArrangedSubview(r)
    r.widthAnchor.constraint(equalTo: parent.widthAnchor).isActive = true
  }
  func updateLabel() {
    slider.doubleValue = Double(frames)
    readout.stringValue =
      frames == 0 ? "额外偏移 0 帧" : "声音额外" + (frames > 0 ? "延后 " : "提前 ") + String(abs(frames)) + " 帧"
    millis.stringValue =
      fps.map { String(format: "%+.1f ms", Double(frames) * 1000 / $0) } ?? "— ms"
    slider.setAccessibilityValueDescription(readout.stringValue + "，" + millis.stringValue)
  }
  func enable(_ value: Bool) {
    connected = value
    slider.isEnabled = value
    buttons.forEach { $0.isEnabled = value }
    loop.isEnabled = value
  }
  func failure(_ error: Error) {
    pending?.cancel()
    generation += 1
    enable(false)
    picker.isEnabled = true
    retry.title = "打开影片"
    retry.isEnabled = true
    status.stringValue = error.localizedDescription
  }
  @objc func connect() {
    guard let selected = player else { return }
    let previous = previousPlayer
    picker.isEnabled = false
    enable(false)
    retry.isHidden = false
    retry.isEnabled = false
    status.stringValue = "正在连接 IINA…"
    let requested = frames
    queue.async {
      do {
        let ipc = try selected.open(replacing: previous)
        try ipc.run(["set_property", "keep-open", "yes"])
        let pid = try ipc.run(["get_property", "pid"]) as? Int32
        guard let nominal = try ipc.run(["get_property", "container-fps"]) as? Double,
          nominal.isFinite && nominal > 0
        else { throw PlayerError("无法读到影片的标称帧率。") }
        try selected.setOffset(ipc, frames: requested, fps: nominal)
        let loopA = try ipc.run(["get_property", "ab-loop-a"]) as? Double
        let loopB = try ipc.run(["get_property", "ab-loop-b"]) as? Double
        DispatchQueue.main.async {
          self.previousPlayer = nil
          self.picker.isEnabled = true
          self.fps = nominal
          self.track.stringValue =
            selected.movie.lastPathComponent + "  ·  " + String(format: "%g fps", nominal)
          self.updateLabel()
          self.enable(true)
          self.retry.title = "显示影片"
          self.retry.isEnabled = true
          if let pid {
            NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
          }
          self.status.stringValue = self.normalStatus
          self.loop.state = loopA != nil && loopB != nil ? .on : .off
          self.panel.makeKeyAndOrderFront(nil)
          self.panel.makeFirstResponder(self.slider)
        }
      } catch { DispatchQueue.main.async { self.failure(error) } }
    }
  }
  @objc func slide() { adjust(Int(slider.doubleValue.rounded())) }
  @objc func minus() { adjust(frames - 1) }
  @objc func plus() { adjust(frames + 1) }
  @objc func zero() { adjust(0) }
  func adjust(_ value: Int) {
    guard connected, let selected = player, let fps else { return }
    frames = min(frameRange.upperBound, max(frameRange.lowerBound, value))
    updateLabel()
    generation += 1
    let version = generation
    let requested = frames
    pending?.cancel()
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      do {
        try selected.setOffset(selected.connection(), frames: requested, fps: fps)
        DispatchQueue.main.async {
          if version == self.generation {
            var saved = UserDefaults.standard.dictionary(forKey: "fileOffsets") ?? [:]
            saved[selected.movie.path] = requested
            UserDefaults.standard.set(saved, forKey: "fileOffsets")
            self.status.stringValue = self.normalStatus
          }
        }
      } catch { DispatchQueue.main.async { if version == self.generation { self.failure(error) } } }
    }
    pending = item
    queue.asyncAfter(deadline: .now() + 0.015, execute: item)
  }
  @objc func playPause() { perform { ipc in try ipc.run(["cycle", "pause"]) } }
  @objc func toggleLoop() {
    guard let selected = player else { return }
    let yes = loop.state == .on
    perform { ipc in try selected.loop(ipc, enabled: yes) }
  }
  func perform(_ action: @escaping (IPC) throws -> Void) {
    guard let selected = player else { return }
    let version = generation
    queue.async {
      do { try action(selected.connection()) } catch {
        DispatchQueue.main.async { if self.generation == version { self.failure(error) } }
      }
    }
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    if !flag { panel.makeKeyAndOrderFront(nil) }
    return true
  }
  func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }
  func applicationWillTerminate(_ notification: Notification) {
    if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
private let controller = Controller()
app.delegate = controller
app.run()
