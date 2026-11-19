import Cocoa
import WebKit

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("WKWebView benchmark: " + message + "\n").utf8))
    exit(1)
}

private final class Runner: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let origin: URL
    let ruleStore: WKContentRuleListStore
    let preference: String
    let openings: Int
    let probePort: Int?
    var window: NSWindow?
    private var nativeSetupMs: Double?

    init(port: Int, ruleStore: WKContentRuleListStore, preference: String, openings: Int, probePort: Int?) {
        self.origin = URL(string: "http://127.0.0.1:\(port)")!
        self.ruleStore = ruleStore
        self.preference = preference
        self.openings = openings
        self.probePort = probePort
    }

    func start() {
        let startedAt = ProcessInfo.processInfo.systemUptime
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "benchmark")
        let setup = #"""
        const post = body => window.webkit.messageHandlers.benchmark.postMessage(body);
        const originalFetch = window.fetch.bind(window);
        window.fetch = (resource, options) => {
          const url = new URL(typeof resource === "string" || resource instanceof URL ? resource : resource.url, location.href);
          if (url.origin !== location.origin || url.pathname.startsWith("/api/")) {
            post({ error: "Unexpected network request" });
            return Promise.reject(new Error("Unexpected network request"));
          }
          return originalFetch(resource, options);
        };
        window.addEventListener("unhandledrejection", () => post({ error: "Unhandled rejection" }));
        window.addEventListener("error", () => post({ error: "Frontend exception" }));
        const preference = "\#(preference)";
        if (preference !== "absent") {
          const valid = {
            guitar: "guitar-1:15-2:17-3:17-4:17-5:15-6:-1-capo-0",
            piano: "piano-c-first-inversion-64-67-72",
            accordion: "accordion-c-rh-second-inversion-octave-3-79-84-88",
          };
          const globalPreferredShapeIds = Object.fromEntries(Object.entries(valid).map(([instrument, id]) => [
            JSON.stringify([instrument, "C"]), preference === "valid" ? id : "stale-generated-voicing-id",
          ]));
          localStorage.setItem("tuneforge.chord-dictionary-preferences.v2",
            JSON.stringify({ version: 2, globalPreferredShapeIds, projectPreferredShapeIds: {} }));
        }
        """#
        config.userContentController.addUserScript(WKUserScript(source: setup, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let allowed = "^http://127[.]0[.]0[.]1:\(origin.port!)/"
        let rules: [[String: [String: String]]] = [
            ["trigger": ["url-filter": ".*"], "action": ["type": "block"]],
            ["trigger": ["url-filter": allowed], "action": ["type": "ignore-previous-rules"]],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: rules),
              let encoded = String(data: data, encoding: .utf8) else { fail("Could not encode content rules") }
        ruleStore.compileContentRuleList(forIdentifier: "fixture-only", encodedContentRuleList: encoded) { list, _ in
            guard let list else { fail("Could not compile content rules") }
            config.userContentController.add(list)
            self.open(config, startedAt: startedAt)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30 + Double(openings)) { fail("Timed out") }
    }

    private func open(_ config: WKWebViewConfiguration, startedAt: TimeInterval) {
        let size = NSRect(x: 100, y: 100, width: 1440, height: 900)
        let web = WKWebView(frame: NSRect(origin: .zero, size: size.size), configuration: config)
        web.navigationDelegate = self
        let panel = NSPanel(contentRect: size, styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = web
        window = panel
        panel.orderFrontRegardless()
        loadWhenVisible(web, in: panel, startedAt: startedAt, deadline: .now() + 5)
    }

    private func loadWhenVisible(_ web: WKWebView, in panel: NSPanel, startedAt: TimeInterval, deadline: DispatchTime) {
        if !panel.isVisible || !panel.occlusionState.contains(.visible) {
            guard DispatchTime.now() < deadline else {
                fail("Fixture panel stayed hidden. Run from an unlocked desktop session.")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(25)) {
                self.loadWhenVisible(web, in: panel, startedAt: startedAt, deadline: deadline)
            }
            return
        }
        let path = probePort == nil ? "/#/tools?tool=metronome" : "/_probe"
        nativeSetupMs = (ProcessInfo.processInfo.systemUptime - startedAt) * 1_000
        web.load(URLRequest(url: URL(string: path, relativeTo: origin)!.absoluteURL))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        guard navigationAction.targetFrame?.isMainFrame == true, url?.scheme == "http",
              url?.host == origin.host, url?.port == origin.port else {
            decisionHandler(.cancel)
            fail("Unexpected navigation")
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("Could not load the fixture")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fail("Web Content process terminated")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let script: String
        if let probePort {
            script = #"""
            void (async () => {
              const url = "http://127.0.0.1:\#(probePort)/";
              const blocked = {};
              try { await originalFetch(url); blocked.fetch = false; } catch { blocked.fetch = true; }
              blocked.xhr = await new Promise(resolve => {
                try {
                  const request = new XMLHttpRequest();
                  request.open("GET", url); request.onload = () => resolve(false); request.onerror = () => resolve(true); request.send();
                } catch { resolve(true); }
              });
              blocked.image = await new Promise(resolve => {
                const image = new Image();
                image.onload = () => resolve(false); image.onerror = () => resolve(true); image.src = url;
              });
              blocked.websocket = await new Promise(resolve => {
                try {
                  const socket = new WebSocket(url.replace("http:", "ws:"));
                  socket.onopen = () => { resolve(false); socket.close(); }; socket.onerror = () => resolve(true);
                } catch { resolve(true); }
              });
              post({ blocked });
            })();
            """#
        } else {
            script = #"""
            void (async () => {
              // WebKit may mark a newly created document hidden until navigation commits.
              const isVisible = () => document.visibilityState === "visible";
              if (!isVisible()) throw new Error("WKWebView was initially hidden. Rerun while the fixture window is visible.");
              let visibilityLost = false;
              document.addEventListener("visibilitychange", () => {
                if (!isVisible()) {
                  visibilityLost = true;
                  post({ error: "WKWebView became hidden. Rerun while the fixture window is visible." });
                }
              });
              function waitFor(check, description) {
                return new Promise((resolve, reject) => {
                  const observer = new MutationObserver(ready);
                  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
                  const timeout = setTimeout(() => {
                    observer.disconnect();
                    reject(new Error(description + " timed out"));
                  }, 8000);
                  function ready() {
                    const found = check();
                    if (found) {
                      observer.disconnect();
                      clearTimeout(timeout);
                      resolve(found);
                    }
                  }
                  ready();
                });
              }
              const tab = name => [...document.querySelectorAll("[role=tab]")].find(button => button.textContent.trim() === name);
              const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
              const selectedLabel = preference === "valid" ? "C voicing 27" : "C voicing 1";
              const expectedCount = preference === "valid" ? 9 : 8;
              const visible = element => element && element.getBoundingClientRect().width > 0;
              function dictionaryReady() {
                const choice = document.querySelector('[aria-label="Global guitar shape preference choices"] [aria-pressed="true"]');
                const grid = document.querySelector(".chord-shape-grid");
                const fret = grid && [...grid.querySelectorAll("button")].find(button => /string \d+ fret \d+/i.test(button.getAttribute("aria-label") || ""));
                const cards = grid?.querySelectorAll(".chord-shape-card").length;
                return visible(choice) && visible(grid) && visible(fret) && cards === expectedCount &&
                  choice.getAttribute("aria-label") === selectedLabel &&
                  tab("Chord Dictionary")?.getAttribute("aria-selected") === "true";
              }
              await waitFor(() => tab("Chord Dictionary"), "Tools");
              const toolsReadyMs = performance.now();
              const measurements = [];
              for (let index = 0; index <= \#(openings); index++) {
                const started = performance.now();
                tab("Chord Dictionary").click();
                await waitFor(dictionaryReady, "Dictionary");
                const domMs = performance.now() - started;
                const firstFrame = await nextFrame();
                const secondFrame = await nextFrame();
                if (!dictionaryReady()) throw new Error("Dictionary changed before the second frame");
                measurements.push({ domMs, twoFramesMs: performance.now() - started, frameCadenceMs: secondFrame - firstFrame });
                tab("Metronome").click();
                await waitFor(() => !document.querySelector(".chord-shape-grid"), "Metronome");
                await nextFrame();
              }
              if (visibilityLost || !isVisible()) throw new Error("WKWebView became hidden. Rerun while the fixture window is visible.");
              post({
                preference, toolsReadyMs, selectedLabel, cards: expectedCount,
                firstOpening: measurements[0], warmOpenings: measurements.slice(1),
                visibility: document.visibilityState, userAgent: navigator.userAgent,
              });
            })().catch(error => post({ error: error.message }));
            """#
        }
        webView.evaluateJavaScript(script) { _, error in
            if error != nil { fail("Injected harness could not run") }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, var body = message.body as? [String: Any] else {
            fail("Invalid harness result")
        }
        if let error = body["error"] as? String { fail(error) }
        if probePort == nil, let nativeSetupMs {
            body["nativeSetupMs"] = nativeSetupMs
        }
        guard let json = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else {
            fail("Could not encode measurements")
        }
        FileHandle.standardOutput.write(json)
        exit(0)
    }
}

let arguments = CommandLine.arguments
guard (5...6).contains(arguments.count), let port = Int(arguments[1]), (1...65535).contains(port),
      let openings = Int(arguments[4]), (1...200).contains(openings),
      ["absent", "valid", "stale"].contains(arguments[3]),
      let store = WKContentRuleListStore(url: URL(fileURLWithPath: arguments[2], isDirectory: true)) else {
    fail("Expected port, rule directory, preference scenario, opening count, and optional probe port")
}
let probePort = arguments.count == 6 ? Int(arguments[5]) : nil
if arguments.count == 6 && !(1...65535).contains(probePort ?? 0) { fail("Invalid probe port") }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
private let runner = Runner(port: port, ruleStore: store, preference: arguments[3], openings: openings, probePort: probePort)
runner.start()
app.run()
