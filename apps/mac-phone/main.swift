// Audio Stroke Phone: a one-window macOS app that runs phone.sh (the SoX-based conversation client)
// and shows its output. Exists so the microphone permission belongs to this app (a double-clickable
// bundle with NSMicrophoneUsageDescription) instead of whichever terminal launched the CLI.
import AVFoundation
import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow!
  private var text: NSTextView!
  private var proc: Process?
  private var startButton: NSButton!
  private var stopButton: NSButton!
  private var redoButton: NSButton!
  private var ready = false
  private var micOK = false

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 920, height: 620),
                      styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "Audio Stroke Phone"
    window.center()
    let content = window.contentView!
    let barH: CGFloat = 44
    let bar = NSView(frame: NSRect(x: 0, y: content.bounds.height - barH, width: content.bounds.width, height: barH))
    bar.autoresizingMask = [.width, .minYMargin]
    startButton = NSButton(title: "開始", target: self, action: #selector(startClicked))
    startButton.bezelStyle = .rounded
    startButton.keyEquivalent = "\r"
    startButton.frame = NSRect(x: 12, y: 8, width: 110, height: 28)
    stopButton = NSButton(title: "停止", target: self, action: #selector(stopClicked))
    stopButton.bezelStyle = .rounded
    stopButton.frame = NSRect(x: 130, y: 8, width: 110, height: 28)
    stopButton.isEnabled = false
    redoButton = NSButton(title: "選び直す", target: self, action: #selector(redoClicked))
    redoButton.bezelStyle = .rounded
    redoButton.frame = NSRect(x: 248, y: 8, width: 110, height: 28)
    bar.addSubview(startButton)
    bar.addSubview(stopButton)
    bar.addSubview(redoButton)
    startButton.isEnabled = false
    content.addSubview(bar)
    let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: content.bounds.width, height: content.bounds.height - barH))
    scroll.autoresizingMask = [.width, .height]
    scroll.hasVerticalScroller = true
    text = NSTextView(frame: scroll.bounds)
    text.isEditable = false
    text.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    text.autoresizingMask = [.width]
    text.isVerticallyResizable = true
    text.textContainer?.widthTracksTextView = true
    scroll.documentView = text
    content.addSubview(scroll)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    requestMic()
    setup()
  }

  private func requestMic() {
    AVCaptureDevice.requestAccess(for: .audio) { ok in
      self.micOK = ok
      self.append(ok ? "マイク: 許可済み\n" : "マイク: 未許可（システム設定 → プライバシーとセキュリティ → マイク で Audio Stroke Phone を許可）\n")
      self.updateButtons()
    }
  }

  private func setup() {
    ready = false
    updateButtons()
    launch(mode: "setup") { code in
      self.ready = (code == 0)
      self.append(self.ready ? "準備完了。「開始」で会話を始めます。\n" : "選択が完了していません。「選び直す」で再選択。\n")
      self.updateButtons()
    }
  }

  private func updateButtons() {
    DispatchQueue.main.async {
      let running = self.proc?.isRunning ?? false
      self.startButton.isEnabled = !running && self.ready && self.micOK
      self.stopButton.isEnabled = running
      self.redoButton.isEnabled = !running
    }
  }

  @objc private func startClicked() {
    if let p = proc, p.isRunning { return }
    launch(mode: "run") { _ in
      self.append("\n[終了] もう一度「開始」で同じ設定の会話。設定を変えるなら「選び直す」。\n")
      self.updateButtons()
    }
  }

  @objc private func redoClicked() {
    if let p = proc, p.isRunning { return }
    text.string = ""
    setup()
  }

  @objc private func stopClicked() {
    if let p = proc, p.isRunning { p.terminate() }
  }

  private func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Quit Audio Stroke Phone", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    let editItem = NSMenuItem()
    main.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    NSApp.mainMenu = main
  }

  private func append(_ s: String) {
    DispatchQueue.main.async {
      self.text.textStorage?.append(NSAttributedString(string: s, attributes: [.font: self.text.font!, .foregroundColor: NSColor.textColor]))
      self.text.scrollToEndOfDocument(nil)
    }
  }

  private func launch(mode: String, done: @escaping (Int32) -> Void) {
    guard let script = Bundle.main.path(forResource: "phone", ofType: "sh") else { append("phone.sh が見つかりません\n"); return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = [script, mode]
    p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    pipe.fileHandleForReading.readabilityHandler = { h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil; return }
      self.append(String(decoding: d, as: UTF8.self))
    }
    p.terminationHandler = { pr in done(pr.terminationStatus) }
    do { try p.run(); proc = p; updateButtons() } catch { append("起動失敗: \(error)\n") }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationWillTerminate(_ note: Notification) {
    if let p = proc, p.isRunning { p.terminate() }
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
