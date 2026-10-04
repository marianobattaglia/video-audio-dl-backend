#!/bin/sh
set -eu

if [ "${1:-}" = "node" ]; then
  if ! iptables -w -L OUTPUT >/dev/null 2>&1 || ! ip6tables -w -L OUTPUT >/dev/null 2>&1; then
    echo "Cannot enforce outbound destination restrictions. This host must support IPv4/IPv6 firewall rules and NET_ADMIN; public deployment is not qualified. The API will not start." >&2
    exit 1
  fi
  iptables -w -F OUTPUT
  iptables -w -P OUTPUT ACCEPT
  iptables -w -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  # Docker translates DNS port 53 to an internal port before the OUTPUT filter.
  iptables -w -A OUTPUT -d 127.0.0.11/32 -p udp -m conntrack --ctorigdstport 53 -j ACCEPT
  iptables -w -A OUTPUT -d 127.0.0.11/32 -p tcp -m conntrack --ctorigdstport 53 -j ACCEPT
  for network in \
    0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
    172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 \
    192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 \
    224.0.0.0/4 240.0.0.0/4; do
    iptables -w -A OUTPUT -d "$network" -j REJECT
  done
  iptables -w -A OUTPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
  iptables -w -A OUTPUT -j REJECT

  ip6tables -w -F OUTPUT
  ip6tables -w -P OUTPUT ACCEPT
  ip6tables -w -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  for network in \
    ::/128 ::1/128 ::ffff:0:0/96 64:ff9b::/96 64:ff9b:1::/48 \
    100::/64 2001::/23 2001:db8::/32 2002::/16 3fff::/20 \
    fc00::/7 fe80::/10 ff00::/8; do
    ip6tables -w -A OUTPUT -d "$network" -j REJECT
  done
  ip6tables -w -A OUTPUT -d 2000::/3 -p tcp -m multiport --dports 80,443 -j ACCEPT
  ip6tables -w -A OUTPUT -j REJECT

  exec gosu node "$@"
fi

exec "$@"
