// Package fetch provides bounded metadata requests. Policy stays outside the
// replaceable HTTP handshake/transport so a future TLS implementation must keep
// the same URL, DNS, redirect, byte and cancellation boundaries.
package fetch

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

var (
	ErrPolicy   = errors.New("outbound request rejected by policy")
	ErrLimit    = errors.New("upstream response exceeds byte limit")
	ErrRedirect = errors.New("upstream redirect limit exceeded")
)

type Policy struct {
	Purpose         string
	AllowedURL      func(string) bool
	Timeout         time.Duration
	MaxBytes        int64
	FollowRedirects bool
	MaxRedirects    int
}

type Request struct {
	URL    string
	Method string
	Header http.Header
	Body   []byte
	Policy Policy
}

type Response struct {
	StatusCode int
	Header     http.Header
	Body       []byte
	URL        string
	// History contains approved redirect targets in encounter order.
	History []string
}

// Executor is injected into platform parsers. It is not a public proxy API.
type Executor interface {
	Do(context.Context, Request) (Response, error)
}

type resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}
type roundTrip func(*http.Request, []netip.Addr) (*http.Response, error)

type Client struct {
	resolver  resolver
	transport roundTrip
}

func New() *Client { return &Client{resolver: net.DefaultResolver, transport: standardRoundTrip} }

// AllowHosts validates server-side request targets separately from the input
// platform registry and URLs merely returned to a browser. Suffix entries begin
// with a dot and include the apex; all other entries are exact hosts.
func AllowHosts(hosts ...string) func(string) bool {
	return func(raw string) bool {
		u, err := checkedURL(raw)
		if err != nil {
			return false
		}
		host := strings.ToLower(u.Hostname())
		for _, allowed := range hosts {
			if strings.HasPrefix(allowed, ".") {
				if host == allowed[1:] || strings.HasSuffix(host, allowed) {
					return true
				}
			} else if host == allowed {
				return true
			}
		}
		return false
	}
}

func checkedURL(raw string) (*url.URL, error) {
	if len(raw) > 8192 {
		return nil, ErrPolicy
	}
	for _, r := range raw {
		if r <= 0x20 || r == 0x7f || r == '\\' {
			return nil, ErrPolicy
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Hostname() == "" || u.Opaque != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, ErrPolicy
	}
	if port := u.Port(); port != "" && !((u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80")) {
		return nil, ErrPolicy
	}
	return u, nil
}

// PublicIP uses the same reserved-network boundary as the PHP media service.
// IPv4-mapped IPv6 is rejected, rather than silently reinterpreted.
func PublicIP(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" || ip.Is4In6() {
		return false
	}
	if ip.Is4() {
		for _, prefix := range blocked4 {
			if prefix.Contains(ip) {
				return false
			}
		}
		return true
	}
	if !global6.Contains(ip) {
		return false
	}
	for _, prefix := range blocked6 {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

var global6 = netip.MustParsePrefix("2000::/3")
var blocked4 = prefixes("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3")
var blocked6 = prefixes("2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20")

func prefixes(values ...string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		out = append(out, netip.MustParsePrefix(value))
	}
	return out
}

func (c *Client) Do(parent context.Context, in Request) (Response, error) {
	p := in.Policy
	if p.AllowedURL == nil || p.Purpose == "" || p.Timeout <= 0 || p.Timeout > 45*time.Second || p.MaxBytes < 1 || p.MaxBytes > 8<<20 || p.MaxRedirects < 0 || p.MaxRedirects > 5 {
		return Response{}, ErrPolicy
	}
	ctx, cancel := context.WithTimeout(parent, p.Timeout)
	defer cancel()
	method := in.Method
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodHead && method != http.MethodPost {
		return Response{}, ErrPolicy
	}
	if len(in.Body) > 1<<20 {
		return Response{}, ErrLimit
	}
	headers := in.Header.Clone()
	if headers == nil {
		headers = make(http.Header)
	}
	// Manual decoding gives identical bounds with caller-specified gzip/deflate.
	if headers.Get("Accept-Encoding") == "" {
		headers.Set("Accept-Encoding", "identity")
	}
	current, body := in.URL, in.Body
	history := []string{}
	for hop := 0; ; hop++ {
		if err := ctx.Err(); err != nil {
			return Response{}, err
		}
		u, err := checkedURL(current)
		if err != nil || !p.AllowedURL(current) {
			return Response{}, ErrPolicy
		}
		ips, err := c.resolver.LookupNetIP(ctx, "ip", u.Hostname())
		if err != nil {
			return Response{}, err
		}
		if len(ips) == 0 {
			return Response{}, ErrPolicy
		}
		for _, ip := range ips {
			if !PublicIP(ip) {
				return Response{}, ErrPolicy
			}
		}
		req, err := http.NewRequestWithContext(ctx, method, current, bytes.NewReader(body))
		if err != nil {
			return Response{}, err
		}
		req.Header = headers.Clone()
		response, err := c.transport(req, ips)
		if err != nil {
			return Response{}, err
		}
		if response == nil || response.Body == nil {
			return Response{}, fmt.Errorf("missing upstream response")
		}
		out := Response{StatusCode: response.StatusCode, Header: response.Header.Clone(), URL: current, History: append([]string(nil), history...)}
		isRedirect := response.StatusCode == 301 || response.StatusCode == 302 || response.StatusCode == 303 || response.StatusCode == 307 || response.StatusCode == 308
		if isRedirect {
			response.Body.Close()
			if !p.FollowRedirects {
				return out, nil
			}
			if hop >= p.MaxRedirects {
				return Response{}, ErrRedirect
			}
			locations := response.Header.Values("Location")
			if len(locations) != 1 || locations[0] == "" {
				return Response{}, ErrRedirect
			}
			relative, err := url.Parse(locations[0])
			if err != nil {
				return Response{}, ErrRedirect
			}
			next := u.ResolveReference(relative)
			if !strings.EqualFold(next.Host, u.Host) {
				headers.Del("Authorization")
				headers.Del("Cookie")
			}
			if (response.StatusCode == 301 || response.StatusCode == 302 || response.StatusCode == 303) && method != http.MethodHead {
				method, body = http.MethodGet, nil
				headers.Del("Content-Type")
			}
			current = next.String()
			history = append(history, current)
			continue
		}
		if method == http.MethodHead {
			response.Body.Close()
			return out, nil
		}
		out.Body, err = readBody(response.Body, response.Header.Get("Content-Encoding"), p.MaxBytes)
		response.Body.Close()
		if err != nil {
			return Response{}, err
		}
		return out, nil
	}
}

// One transport per outbound hop keeps DNS checks and the actual socket bound
// together. A platform cannot enable environment proxies, redirects or cookies.
// The transport replacement point receives only already approved IPs.
func standardRoundTrip(req *http.Request, ips []netip.Addr) (*http.Response, error) {
	host, port := req.URL.Hostname(), req.URL.Port()
	if port == "" {
		if req.URL.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	transport := &http.Transport{
		Proxy: nil, DisableCompression: true, DisableKeepAlives: true,
		TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 20 * time.Second,
		MaxResponseHeaderBytes: 64 << 10, ForceAttemptHTTP2: true,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			wanted := net.JoinHostPort(host, port)
			if address != wanted {
				return nil, ErrPolicy
			}
			var last error
			for _, ip := range ips {
				conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), port))
				if err == nil {
					return conn, nil
				}
				last = err
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
			}
			return nil, last
		},
	}
	// http.Transport retains the original URL hostname for TLS SNI and
	// certificate verification; no InsecureSkipVerify or IP URL substitution.
	return transport.RoundTrip(req)
}

func readBody(body io.Reader, encoding string, limit int64) ([]byte, error) {
	wire, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(wire)) > limit {
		return nil, ErrLimit
	}
	var decoded io.ReadCloser
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "identity":
		return wire, nil
	case "gzip":
		decoded, err = gzip.NewReader(bytes.NewReader(wire))
	case "deflate":
		decoded, err = zlib.NewReader(bytes.NewReader(wire))
		if err != nil {
			decoded, err = flate.NewReader(bytes.NewReader(wire)), nil
		}
	default:
		return nil, fmt.Errorf("unsupported response content encoding")
	}
	if err != nil {
		return nil, err
	}
	defer decoded.Close()
	value, err := io.ReadAll(io.LimitReader(decoded, limit+1))
	if int64(len(value)) > limit {
		return nil, ErrLimit
	}
	return value, err
}
