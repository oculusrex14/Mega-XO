import AppKit
import Foundation

// P20 simulator gate: screenshot-exists is NOT first-launch proof. Compare
// a stable grid of pixels against the same simulator's SpringBoard before
// app launch. A crash/empty scene returning to Home must fail this job.
// This detects a false-positive, not the entire game/UI parity requirement.
func fail(_ message: String) -> Never {
    fputs("IOS_FIRST_LAUNCH: " + message + "\n", stderr)
    exit(2)
}
guard CommandLine.arguments.count == 3 else { fail("expected home.png and after.png") }

func load(_ path: String) -> NSBitmapImageRep {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let bitmap = NSBitmapImageRep(data: data) else { fail("invalid screenshot PNG") }
    return bitmap
}
let before = load(CommandLine.arguments[1])
let after = load(CommandLine.arguments[2])
if before.pixelsWide != after.pixelsWide || before.pixelsHigh != after.pixelsHigh {
    print("IOS_FIRST_LAUNCH: simulator display geometry changed after app launch")
    exit(0)
}

let w = before.pixelsWide, h = before.pixelsHigh
var samples = 0, changed = 0
let stepX = max(1, w / 40), stepY = max(1, h / 50)
for y in stride(from: h / 10, to: h * 9 / 10, by: stepY) {
    for x in stride(from: w / 8, to: w * 7 / 8, by: stepX) {
        guard let a = before.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
              let b = after.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else {
            fail("unreadable screenshot pixel")
        }
        samples += 1
        let delta = max(
            abs(a.redComponent - b.redComponent),
            abs(a.greenComponent - b.greenComponent),
            abs(a.blueComponent - b.blueComponent))
        if delta > 0.10 { changed += 1 }
    }
}
guard samples > 100 else { fail("insufficient screenshot samples") }
let fraction = Double(changed) / Double(samples)
print(String(format: "IOS_FIRST_LAUNCH: %d/%d (%.1f%%) sample pixels changed after launch",
             changed, samples, fraction * 100))
if fraction < 0.15 {
    fail("simulator is still showing SpringBoard (or app immediately returned to Home)")
}
