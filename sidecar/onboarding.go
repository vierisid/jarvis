package main

import (
	"bufio"
	"fmt"
	"io"
	"net/url"
	"strings"
)

func applyEnrollmentToken(cfg *SidecarConfig, token string, in io.Reader, out io.Writer, interactive bool) error {
	cfg.Token = token

	claims, err := DecodeJWTPayload(token)
	if err != nil {
		return fmt.Errorf("decode enrollment token: %w", err)
	}

	if interactive {
		if err := promptDashboardOverride(cfg, claims, in, out); err != nil {
			return err
		}
	}

	return nil
}

func promptDashboardOverride(cfg *SidecarConfig, claims *SidecarTokenClaims, in io.Reader, out io.Writer) error {
	existing := strings.TrimSpace(cfg.Brain)
	suggested := existing
	if suggested == "" && claims != nil {
		suggested = dashboardURLFromBrainEndpoint(claims.Brain)
	}

	fmt.Fprintln(out, "[sidecar] Sidecar onboarding")
	switch {
	case suggested != "" && existing != "":
		fmt.Fprintf(out, "[sidecar] Dashboard URL [%s]: ", suggested)
	case suggested != "":
		fmt.Fprintf(out, "[sidecar] Dashboard URL (press Enter to use the token default) [%s]: ", suggested)
	default:
		fmt.Fprint(out, "[sidecar] Dashboard URL (optional, press Enter to use the token default): ")
	}

	answer, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && err != io.EOF {
		return fmt.Errorf("read dashboard url: %w", err)
	}

	answer = strings.TrimSpace(answer)
	if answer != "" {
		cfg.Brain = answer
		return nil
	}

	if existing == "" {
		cfg.Brain = ""
	}

	return nil
}

func dashboardURLFromBrainEndpoint(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}

	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return trimmed
	}

	switch parsed.Scheme {
	case "ws":
		parsed.Scheme = "http"
	case "wss":
		parsed.Scheme = "https"
	}

	path := strings.TrimSuffix(strings.TrimRight(parsed.Path, "/"), "/sidecar/connect")
	parsed.Path = path
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""

	if parsed.Path == "" {
		return fmt.Sprintf("%s://%s", parsed.Scheme, parsed.Host)
	}

	return parsed.String()
}
