package main

// OCRResult is the output of platformOCR.
type OCRResult struct {
	Text       string `json:"text"`
	DurationMs int64  `json:"duration_ms"`
}
