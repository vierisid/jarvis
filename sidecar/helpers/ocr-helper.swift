// ocr-helper: macOS Vision OCR companion for jarvis-sidecar.
//
// Reads an image path from argv[1], runs VNRecognizeTextRequest, and writes
// JSON {"text": "..."} to stdout. Errors go to stderr with a non-zero exit.
//
// Build (macOS only):
//   swiftc -O helpers/ocr-helper.swift -o helpers/ocr-helper

import Vision
import Foundation
import CoreGraphics
import ImageIO

func fail(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(code)
}

guard CommandLine.arguments.count > 1 else {
    fail("usage: ocr-helper <image-path>", 1)
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)

guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else {
    fail("failed to open image: \(path)", 2)
}
guard let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fail("failed to decode image at index 0: \(path)", 2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

// Use every language the current Vision revision supports, so OCR works
// regardless of the user's display language. If the query fails (e.g. on
// an OS version that doesn't expose it the same way), fall back to the
// Vision default of English.
if let supported = try? VNRecognizeTextRequest.supportedRecognitionLanguages(
    for: .accurate,
    revision: VNRecognizeTextRequest.currentRevision
), !supported.isEmpty {
    request.recognitionLanguages = supported
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("vision request failed: \(error.localizedDescription)", 3)
}

// Explicit cast: on older SDKs request.results is [VNObservation]?, and
// VNObservation does not expose topCandidates.
let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
let lines = observations.compactMap { $0.topCandidates(1).first?.string }
let text = lines.joined(separator: "\n")

let output: [String: Any] = ["text": text]
guard let json = try? JSONSerialization.data(withJSONObject: output, options: []) else {
    fail("json encode failed", 4)
}
FileHandle.standardOutput.write(json)
