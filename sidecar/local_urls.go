package main

import (
	"fmt"
	"net/url"
)

const localLoopbackIPv4 = "127.0.0.1"

func localCDPHTTPURL(port int, path string) string {
	return fmt.Sprintf("http://%s:%d%s", localLoopbackIPv4, port, path)
}

func preferIPv4Loopback(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if parsed.Hostname() != "localhost" {
		return raw
	}

	if port := parsed.Port(); port != "" {
		parsed.Host = netJoinHostPort(localLoopbackIPv4, port)
	} else {
		parsed.Host = localLoopbackIPv4
	}
	return parsed.String()
}

func netJoinHostPort(host, port string) string {
	return host + ":" + port
}
