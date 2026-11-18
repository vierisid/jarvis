//go:build !linux

package main

import "errors"

func abiVersion() int { return 0 }

func restrictAndExec(policy) error {
	return errors.New("Landlock is Linux only")
}
