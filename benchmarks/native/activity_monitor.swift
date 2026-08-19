import AppKit
import CoreGraphics
import Foundation

struct Sample {
	let cursor: CGPoint
	let pid: pid_t?
	let app: String?
}

let startedAt = Date()
let initial = Sample(
	cursor: CGEvent(source: nil)?.location ?? .zero,
	pid: NSWorkspace.shared.frontmostApplication?.processIdentifier,
	app: NSWorkspace.shared.frontmostApplication?.localizedName
)
var lastPid = initial.pid
var focusChanges = 0
var focusApps = initial.app.map { [$0] } ?? []
var maximumCursorDistance = 0.0
var sampleCount = 0

func sample() {
	let current = Sample(
		cursor: CGEvent(source: nil)?.location ?? initial.cursor,
		pid: NSWorkspace.shared.frontmostApplication?.processIdentifier,
		app: NSWorkspace.shared.frontmostApplication?.localizedName
	)
	let distance = hypot(current.cursor.x - initial.cursor.x, current.cursor.y - initial.cursor.y)
	maximumCursorDistance = max(maximumCursorDistance, distance)
	if current.pid != lastPid {
		focusChanges += 1
		lastPid = current.pid
		if let app = current.app, focusApps.last != app { focusApps.append(app) }
	}
	sampleCount += 1
}

func emitAndExit() {
	sample()
	let current = CGEvent(source: nil)?.location ?? initial.cursor
	let payload: [String: Any] = [
		"durationMs": Int(Date().timeIntervalSince(startedAt) * 1_000),
		"sampleCount": sampleCount,
		"startCursor": ["x": initial.cursor.x, "y": initial.cursor.y],
		"endCursor": ["x": current.x, "y": current.y],
		"maximumCursorDistance": maximumCursorDistance,
		"focusChanges": focusChanges,
		"focusApps": focusApps,
		"startFrontmostPid": initial.pid.map(Int.init) ?? 0,
		"endFrontmostPid": NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) } ?? 0,
	]
	let data = try! JSONSerialization.data(withJSONObject: payload)
	FileHandle.standardOutput.write(data)
	FileHandle.standardOutput.write(Data("\n".utf8))
	exit(0)
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler(handler: emitAndExit)
term.resume()
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interrupt.setEventHandler(handler: emitAndExit)
interrupt.resume()
Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in sample() }
RunLoop.main.run()
