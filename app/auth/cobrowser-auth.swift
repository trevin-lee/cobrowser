// cobrowser-auth: asks macOS to confirm the person at the Mac, the way Safari does before it
// shows a password: Touch ID (or an Apple Watch) when there is one, and the Mac's login
// password otherwise, or instead ("Use Password…"). Electron's own prompt is Touch ID only.
//
//   cobrowser-auth "<reason>"   exit 0 confirmed · 1 cancelled or failed · 2 cannot ask
//   cobrowser-auth --check      prints {"biometrics":bool,"password":bool}
//
// The app runs it for every vault check and ends it (SIGTERM) to withdraw an unanswered prompt.
// macOS shows "cobrowser is trying to <reason>." (the name comes from the embedded Info.plist).
import Foundation
import LocalAuthentication

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

let args = Array(CommandLine.arguments.dropFirst())

if args.first == "--check" {
  let biometrics = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
  let password = LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
  print("{\"biometrics\":\(biometrics),\"password\":\(password)}")
  exit(0)
}

guard let reason = args.first, !reason.isEmpty else { fail(64, "usage: cobrowser-auth <reason> | --check") }

let context = LAContext()
var unavailable: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &unavailable) else {
  fail(2, "cannot ask: \(unavailable?.localizedDescription ?? "no way to confirm on this Mac")")
}

// Withdraw the prompt when the app gives up waiting.
signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
term.setEventHandler {
  context.invalidate()
  fail(1, "withdrawn")
}
term.resume()

let answered = DispatchSemaphore(value: 0)
var confirmed = false
var why = ""
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
  confirmed = success
  why = error?.localizedDescription ?? ""
  answered.signal()
}
answered.wait()
if !confirmed { fail(1, why.isEmpty ? "cancelled" : why) }
exit(0)
