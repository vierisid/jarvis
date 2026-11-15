//go:build !windows

package main

// On this system neither fact is read yet: the brain is told nothing, and so
// holds nothing back for a call and says nothing about the connection.
func platformNotchAroundStart(a *NotchAround) {}
