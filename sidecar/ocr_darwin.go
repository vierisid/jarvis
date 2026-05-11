//go:build darwin

package main

import "fmt"

func platformOCR(imagePath string) (OCRResult, error) {
	return OCRResult{}, fmt.Errorf("ocr not yet implemented on darwin")
}

func checkOCR() string {
	return "ocr not yet implemented on darwin"
}
