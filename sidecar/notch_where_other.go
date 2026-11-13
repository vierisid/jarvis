//go:build !windows && !darwin

package main

// Hearing which app is in front is built for Windows and the Mac. Here
// nothing is heard, so nothing is said and nothing is held back.
func platformNotchWhereStart(w *NotchWhere) (stop func()) { return func() {} }
