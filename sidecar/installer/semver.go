package main

import (
	"fmt"
	"strconv"
	"strings"
)

// semver is the minimal parser this program needs: MAJOR.MINOR.PATCH with an
// optional prerelease tag. Build metadata (+…) is ignored per spec.
type semver struct {
	major, minor, patch int
	pre                 string
}

func parseSemver(s string) (semver, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexByte(s, '+'); i >= 0 {
		s = s[:i]
	}
	var v semver
	if i := strings.IndexByte(s, '-'); i >= 0 {
		v.pre = s[i+1:]
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return v, fmt.Errorf("not a semver: %q", s)
	}
	var err error
	if v.major, err = strconv.Atoi(parts[0]); err != nil {
		return v, fmt.Errorf("not a semver: %q", s)
	}
	if v.minor, err = strconv.Atoi(parts[1]); err != nil {
		return v, fmt.Errorf("not a semver: %q", s)
	}
	if v.patch, err = strconv.Atoi(parts[2]); err != nil {
		return v, fmt.Errorf("not a semver: %q", s)
	}
	return v, nil
}

// compareSemver returns -1/0/+1. A prerelease sorts before its release
// (1.2.3-rc.1 < 1.2.3); prerelease identifiers compare per semver §11
// (numeric identifiers numerically and lower than alphanumeric ones).
func compareSemver(a, b semver) int {
	for _, d := range [3]int{a.major - b.major, a.minor - b.minor, a.patch - b.patch} {
		if d < 0 {
			return -1
		}
		if d > 0 {
			return 1
		}
	}
	switch {
	case a.pre == b.pre:
		return 0
	case a.pre == "":
		return 1
	case b.pre == "":
		return -1
	}
	as, bs := strings.Split(a.pre, "."), strings.Split(b.pre, ".")
	for i := 0; i < len(as) && i < len(bs); i++ {
		an, aerr := strconv.Atoi(as[i])
		bn, berr := strconv.Atoi(bs[i])
		switch {
		case aerr == nil && berr == nil:
			if an != bn {
				if an < bn {
					return -1
				}
				return 1
			}
		case aerr == nil:
			return -1 // numeric < alphanumeric
		case berr == nil:
			return 1
		default:
			if c := strings.Compare(as[i], bs[i]); c != 0 {
				return c
			}
		}
	}
	switch {
	case len(as) < len(bs):
		return -1
	case len(as) > len(bs):
		return 1
	}
	return 0
}

// versionLess reports a < b for two version strings; parse failures make the
// unparseable side lose (so a weird installed version still updates).
func versionLess(a, b string) bool {
	av, aerr := parseSemver(a)
	bv, berr := parseSemver(b)
	if aerr != nil {
		return berr == nil
	}
	if berr != nil {
		return false
	}
	return compareSemver(av, bv) < 0
}
