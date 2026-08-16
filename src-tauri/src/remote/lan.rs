//! Which address on this machine a phone on the same network can reach.
//!
//! Enumerating interfaces means a different platform API on every platform, so
//! this asks the routing table instead. Connecting a UDP socket sends nothing —
//! it only fixes the local end of a would-be conversation — and the local
//! address the kernel picks is, by definition, the one packets to that
//! destination would leave from.
//!
//! Asking about several destinations rather than one is what makes this useful
//! on a real desktop. A machine on Wi-Fi with a VPN up, or with a hypervisor's
//! virtual switch installed, has more than one answer, and the route to the
//! public internet is often not the route to the phone in the room.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

/// Destinations whose routes are worth asking about. None is contacted: the
/// port is DNS only because a plausible destination reads better in a firewall
/// log than port 9 would.
const PROBES: [(Ipv4Addr, u16); 5] = [
    // The default route, which is the answer on a machine with one network.
    (Ipv4Addr::new(8, 8, 8, 8), 53),
    // The three private ranges, which is where the phone actually is.
    (Ipv4Addr::new(192, 168, 1, 1), 53),
    (Ipv4Addr::new(10, 0, 0, 1), 53),
    (Ipv4Addr::new(172, 16, 0, 1), 53),
    // Link-local, for a laptop and a phone sharing an ad-hoc network with no
    // DHCP server between them.
    (Ipv4Addr::new(169, 254, 1, 1), 53),
];

/// Every local IPv4 this machine would use to reach a nearby network, best
/// candidate first, without duplicates.
///
/// Loopback is never returned: an address a phone cannot reach is not an answer
/// to this question, and returning one would put a dead URL in a QR code.
pub fn addresses() -> Vec<Ipv4Addr> {
    let mut found: Vec<Ipv4Addr> = Vec::new();

    for (host, port) in PROBES {
        let Some(local) = local_address_for(SocketAddr::from((host, port))) else {
            continue;
        };
        if local.is_loopback() || local.is_unspecified() || found.contains(&local) {
            continue;
        }
        found.push(local);
    }

    // A private address is the one a phone on the same Wi-Fi can use; a public
    // one usually means this machine is the router, or is behind none.
    found.sort_by_key(|address| !is_private(address));
    found
}

/// The single best address, or `None` on a machine with no network at all.
pub fn best_address() -> Option<Ipv4Addr> {
    addresses().into_iter().next()
}

fn local_address_for(destination: SocketAddr) -> Option<Ipv4Addr> {
    // Bound to the wildcard so the kernel, not this code, chooses the source.
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(destination).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(address) => Some(address),
        IpAddr::V6(_) => None,
    }
}

fn is_private(address: &Ipv4Addr) -> bool {
    address.is_private() || address.is_link_local()
}

#[cfg(test)]
mod tests {
    use super::{addresses, is_private};
    use std::net::Ipv4Addr;

    #[test]
    fn never_offers_an_address_a_phone_cannot_reach() {
        for address in addresses() {
            assert!(!address.is_loopback(), "{address} is loopback");
            assert!(!address.is_unspecified(), "{address} is unspecified");
        }
    }

    #[test]
    fn has_no_duplicates() {
        let found = addresses();
        let mut unique = found.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(found.len(), unique.len());
    }

    #[test]
    fn ranks_a_lan_address_above_a_public_one() {
        assert!(is_private(&Ipv4Addr::new(192, 168, 0, 4)));
        assert!(is_private(&Ipv4Addr::new(10, 1, 2, 3)));
        assert!(!is_private(&Ipv4Addr::new(203, 0, 113, 7)));
    }
}
