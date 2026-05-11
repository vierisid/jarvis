//go:build windows

package main

import "fmt"

func platformOCR(imagePath string) (OCRResult, error) {
	return OCRResult{}, fmt.Errorf("ocr not yet implemented on windows")
}

func checkOCR() string {
	return "ocr not yet implemented on windows"
}
