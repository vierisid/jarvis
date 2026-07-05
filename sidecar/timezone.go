package main

// Machine timezone detection (IANA name, e.g. "America/New_York").
//
// Reported to the brain on register (alongside hostname) so a HOSTED brain -
// which runs on a UTC VPS - can fire its local-time crons in the user's real
// timezone, and the hosting server can schedule maintenance follow-the-night.
// Best-effort: an empty string means "unknown" and consumers fall back to
// their own default (the brain then uses the VPS clock; the server uses its
// unknown-timezone window).

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// ianaNameRe accepts "Area/City", "Area/Sub/City", "UTC", "Etc/UTC" - enough
// to reject garbage (paths, Windows display names) without embedding tzdata.
var ianaNameRe = regexp.MustCompile(`^[A-Za-z_+-]+(/[A-Za-z0-9_+-]+){0,2}$`)

// DetectIANATimezone returns the machine's IANA timezone name, or "" when it
// cannot be determined confidently.
func DetectIANATimezone() string {
	// 1. Explicit TZ env wins everywhere (POSIX; ":Area/City" form included).
	if tz := strings.TrimPrefix(strings.TrimSpace(os.Getenv("TZ")), ":"); tz != "" && ianaNameRe.MatchString(tz) {
		return tz
	}

	switch runtimeGOOS() {
	case "windows":
		return windowsIANATimezone()
	default:
		return unixIANATimezone("/etc/localtime", "/etc/timezone")
	}
}

// runtimeGOOS is indirected for tests.
var runtimeGOOS = func() string { return runtime.GOOS }

// unixIANATimezone resolves the zone from the /etc/localtime symlink
// (macOS + most Linux) with Debian's /etc/timezone as a fallback.
func unixIANATimezone(localtimePath, timezonePath string) string {
	if target, err := filepath.EvalSymlinks(localtimePath); err == nil {
		// .../zoneinfo/Europe/Rome -> Europe/Rome (also handles the
		// "zoneinfo.default" dir some distros use).
		if idx := strings.LastIndex(target, "zoneinfo"); idx != -1 {
			rest := target[idx:]
			if slash := strings.Index(rest, "/"); slash != -1 {
				name := rest[slash+1:]
				if ianaNameRe.MatchString(name) {
					return name
				}
			}
		}
	}

	if raw, err := os.ReadFile(timezonePath); err == nil {
		name := strings.TrimSpace(string(raw))
		if ianaNameRe.MatchString(name) {
			return name
		}
	}

	return ""
}

// windowsIANATimezone maps `tzutil /g` output (a Windows zone id) to the
// CLDR primary IANA zone. The map covers the standard Windows zone ids;
// unknown ids return "" (server-side unknown-timezone fallback applies).
func windowsIANATimezone() string {
	out, err := exec.Command("tzutil", "/g").Output()
	if err != nil {
		return ""
	}
	return windowsZoneToIANA[strings.TrimSpace(string(out))]
}

// windowsZoneToIANA is the CLDR windowsZones "001" (primary) mapping.
var windowsZoneToIANA = map[string]string{
	"Dateline Standard Time":          "Etc/GMT+12",
	"UTC-11":                          "Etc/GMT+11",
	"Aleutian Standard Time":          "America/Adak",
	"Hawaiian Standard Time":          "Pacific/Honolulu",
	"Marquesas Standard Time":         "Pacific/Marquesas",
	"Alaskan Standard Time":           "America/Anchorage",
	"UTC-09":                          "Etc/GMT+9",
	"Pacific Standard Time (Mexico)":  "America/Tijuana",
	"UTC-08":                          "Etc/GMT+8",
	"Pacific Standard Time":           "America/Los_Angeles",
	"US Mountain Standard Time":       "America/Phoenix",
	"Mountain Standard Time (Mexico)": "America/Mazatlan",
	"Mountain Standard Time":          "America/Denver",
	"Yukon Standard Time":             "America/Whitehorse",
	"Central America Standard Time":   "America/Guatemala",
	"Central Standard Time":           "America/Chicago",
	"Easter Island Standard Time":     "Pacific/Easter",
	"Central Standard Time (Mexico)":  "America/Mexico_City",
	"Canada Central Standard Time":    "America/Regina",
	"SA Pacific Standard Time":        "America/Bogota",
	"Eastern Standard Time (Mexico)":  "America/Cancun",
	"Eastern Standard Time":           "America/New_York",
	"Haiti Standard Time":             "America/Port-au-Prince",
	"Cuba Standard Time":              "America/Havana",
	"US Eastern Standard Time":        "America/Indiana/Indianapolis",
	"Turks And Caicos Standard Time":  "America/Grand_Turk",
	"Paraguay Standard Time":          "America/Asuncion",
	"Atlantic Standard Time":          "America/Halifax",
	"Venezuela Standard Time":         "America/Caracas",
	"Central Brazilian Standard Time": "America/Cuiaba",
	"SA Western Standard Time":        "America/La_Paz",
	"Pacific SA Standard Time":        "America/Santiago",
	"Newfoundland Standard Time":      "America/St_Johns",
	"Tocantins Standard Time":         "America/Araguaina",
	"E. South America Standard Time":  "America/Sao_Paulo",
	"SA Eastern Standard Time":        "America/Cayenne",
	"Argentina Standard Time":         "America/Argentina/Buenos_Aires",
	"Montevideo Standard Time":        "America/Montevideo",
	"Magallanes Standard Time":        "America/Punta_Arenas",
	"Saint Pierre Standard Time":      "America/Miquelon",
	"Bahia Standard Time":             "America/Bahia",
	"UTC-02":                          "Etc/GMT+2",
	"Greenland Standard Time":         "America/Nuuk",
	"Azores Standard Time":            "Atlantic/Azores",
	"Cape Verde Standard Time":        "Atlantic/Cape_Verde",
	"UTC":                             "Etc/UTC",
	"GMT Standard Time":               "Europe/London",
	"Greenwich Standard Time":         "Atlantic/Reykjavik",
	"Sao Tome Standard Time":          "Africa/Sao_Tome",
	"Morocco Standard Time":           "Africa/Casablanca",
	"W. Europe Standard Time":         "Europe/Berlin",
	"Central Europe Standard Time":    "Europe/Budapest",
	"Romance Standard Time":           "Europe/Paris",
	"Central European Standard Time":  "Europe/Warsaw",
	"W. Central Africa Standard Time": "Africa/Lagos",
	"GTB Standard Time":               "Europe/Bucharest",
	"Middle East Standard Time":       "Asia/Beirut",
	"Egypt Standard Time":             "Africa/Cairo",
	"E. Europe Standard Time":         "Europe/Chisinau",
	"West Bank Standard Time":         "Asia/Hebron",
	"South Africa Standard Time":      "Africa/Johannesburg",
	"FLE Standard Time":               "Europe/Kiev",
	"Israel Standard Time":            "Asia/Jerusalem",
	"South Sudan Standard Time":       "Africa/Juba",
	"Kaliningrad Standard Time":       "Europe/Kaliningrad",
	"Sudan Standard Time":             "Africa/Khartoum",
	"Libya Standard Time":             "Africa/Tripoli",
	"Namibia Standard Time":           "Africa/Windhoek",
	"Jordan Standard Time":            "Asia/Amman",
	"Arabic Standard Time":            "Asia/Baghdad",
	"Syria Standard Time":             "Asia/Damascus",
	"Turkey Standard Time":            "Europe/Istanbul",
	"Arab Standard Time":              "Asia/Riyadh",
	"Belarus Standard Time":           "Europe/Minsk",
	"Russian Standard Time":           "Europe/Moscow",
	"E. Africa Standard Time":         "Africa/Nairobi",
	"Volgograd Standard Time":         "Europe/Volgograd",
	"Iran Standard Time":              "Asia/Tehran",
	"Arabian Standard Time":           "Asia/Dubai",
	"Astrakhan Standard Time":         "Europe/Astrakhan",
	"Azerbaijan Standard Time":        "Asia/Baku",
	"Russia Time Zone 3":              "Europe/Samara",
	"Mauritius Standard Time":         "Indian/Mauritius",
	"Saratov Standard Time":           "Europe/Saratov",
	"Georgian Standard Time":          "Asia/Tbilisi",
	"Caucasus Standard Time":          "Asia/Yerevan",
	"Afghanistan Standard Time":       "Asia/Kabul",
	"West Asia Standard Time":         "Asia/Tashkent",
	"Ekaterinburg Standard Time":      "Asia/Yekaterinburg",
	"Pakistan Standard Time":          "Asia/Karachi",
	"Qyzylorda Standard Time":         "Asia/Qyzylorda",
	"India Standard Time":             "Asia/Kolkata",
	"Sri Lanka Standard Time":         "Asia/Colombo",
	"Nepal Standard Time":             "Asia/Kathmandu",
	"Central Asia Standard Time":      "Asia/Almaty",
	"Bangladesh Standard Time":        "Asia/Dhaka",
	"Omsk Standard Time":              "Asia/Omsk",
	"Myanmar Standard Time":           "Asia/Yangon",
	"SE Asia Standard Time":           "Asia/Bangkok",
	"Altai Standard Time":             "Asia/Barnaul",
	"W. Mongolia Standard Time":       "Asia/Hovd",
	"North Asia Standard Time":        "Asia/Krasnoyarsk",
	"N. Central Asia Standard Time":   "Asia/Novosibirsk",
	"Tomsk Standard Time":             "Asia/Tomsk",
	"China Standard Time":             "Asia/Shanghai",
	"North Asia East Standard Time":   "Asia/Irkutsk",
	"Singapore Standard Time":         "Asia/Singapore",
	"W. Australia Standard Time":      "Australia/Perth",
	"Taipei Standard Time":            "Asia/Taipei",
	"Ulaanbaatar Standard Time":       "Asia/Ulaanbaatar",
	"Aus Central W. Standard Time":    "Australia/Eucla",
	"Transbaikal Standard Time":       "Asia/Chita",
	"Tokyo Standard Time":             "Asia/Tokyo",
	"North Korea Standard Time":       "Asia/Pyongyang",
	"Korea Standard Time":             "Asia/Seoul",
	"Yakutsk Standard Time":           "Asia/Yakutsk",
	"Cen. Australia Standard Time":    "Australia/Adelaide",
	"AUS Central Standard Time":       "Australia/Darwin",
	"E. Australia Standard Time":      "Australia/Brisbane",
	"AUS Eastern Standard Time":       "Australia/Sydney",
	"West Pacific Standard Time":      "Pacific/Port_Moresby",
	"Tasmania Standard Time":          "Australia/Hobart",
	"Vladivostok Standard Time":       "Asia/Vladivostok",
	"Lord Howe Standard Time":         "Australia/Lord_Howe",
	"Bougainville Standard Time":      "Pacific/Bougainville",
	"Russia Time Zone 10":             "Asia/Srednekolymsk",
	"Magadan Standard Time":           "Asia/Magadan",
	"Norfolk Standard Time":           "Pacific/Norfolk",
	"Sakhalin Standard Time":          "Asia/Sakhalin",
	"Central Pacific Standard Time":   "Pacific/Guadalcanal",
	"Russia Time Zone 11":             "Asia/Kamchatka",
	"New Zealand Standard Time":       "Pacific/Auckland",
	"UTC+12":                          "Etc/GMT-12",
	"Fiji Standard Time":              "Pacific/Fiji",
	"Chatham Islands Standard Time":   "Pacific/Chatham",
	"UTC+13":                          "Etc/GMT-13",
	"Tonga Standard Time":             "Pacific/Tongatapu",
	"Samoa Standard Time":             "Pacific/Apia",
	"Line Islands Standard Time":      "Pacific/Kiritimati",
}
