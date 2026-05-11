// ocr-helper: macOS Vision OCR companion for jarvis-sidecar.
//
// Reads a PNG/JPEG path from argv[1], runs VNRecognizeTextRequest, and writes
// JSON {"text": "..."} to stdout. Errors go to stderr with a non-zero exit.
//
// Build (macOS only):
//   swiftc -O helpers/ocr-helper.swift -o helpers/ocr-helper

import Vision
import Foundation
import CoreGraphics
import ImageIO

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write(Data("usage: ocr-helper <image-path>\n".utf8))
    exit(1)
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)

guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write(Data("failed to load image: \(path)\n".utf8))
    exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write(Data("vision request failed: \(error)\n".utf8))
    exit(3)
}

let observations = request.results ?? []
let lines = observations.compactMap { $0.topCandidates(1).first?.string }
let text = lines.joined(separator: "\n")

let output: [String: Any] = ["text": text]
guard let json = try? JSONSerialization.data(withJSONObject: output, options: []) else {
    FileHandle.standardError.write(Data("json encode failed\n".utf8))
    exit(4)
}
FileHandle.standardOutput.write(json)
