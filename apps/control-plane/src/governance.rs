//! Cost / rate governance (CP6–CP8): a pure decision engine.
//!
//! Inputs: per-agent usage reports (tokens spent in the current window,
//! rate-limit hits). State: budget grants (leases). Outputs: traffic light +
//! actions — throttle, tier downgrade BEFORE the 429 arrives, pause, fleet
//! sequential mode on cascade. All clocks injected; no I/O in this module.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Haiku,
    Sonnet,
    Opus,
}

impl Tier {
    pub fn downgraded(self) -> Option<Tier> {
        match self {
            Tier::Opus => Some(Tier::Sonnet),
            Tier::Sonnet => Some(Tier::Haiku),
            Tier::Haiku => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Light {
    Green,
    Yellow,
    Red,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "action")]
pub enum Action {
    None,
    /// Insert this many ms between requests.
    Throttle {
        delay_ms: u64,
    },
    /// Write the model override for this agent (its manager applies it).
    Downgrade {
        to: Tier,
    },
    /// Stop dispatching to this agent until the window resets.
    Pause,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FleetMode {
    Parallel,
    /// Cascade detected: agents run one-at-a-time until the window clears.
    Sequential,
}

/// One agent's usage inside the current governance window.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Usage {
    pub tokens_spent: u64,
    pub rate_limit_hits: u32,
    /// Epoch secs of the most recent rate-limit hit (0 = none).
    pub last_rate_limited_epoch: i64,
    /// The model tier the agent is CURRENTLY running (self-reported; the
    /// agent's manager knows). None = not reported this window.
    #[serde(default)]
    pub tier: Option<Tier>,
}

/// A budget grant is a LEASE (CP8): unspent budget returns to the pool at
/// expiry rather than sitting reserved on an idle agent.
#[derive(Debug, Clone, Serialize)]
pub struct BudgetGrant {
    pub agent: String,
    pub granted_tokens: u64,
    pub expires_epoch: i64,
}

pub struct Governor {
    /// Fleet-wide token pool per window.
    pub pool_tokens: u64,
    /// Traffic-light thresholds as fractions of an agent's grant.
    pub yellow_at: f64,
    pub red_at: f64,
    /// Cascade: this many rate-limited agents within `cascade_window_secs`.
    pub cascade_agents: usize,
    pub cascade_window_secs: i64,
    grants: BTreeMap<String, BudgetGrant>,
}

impl Governor {
    pub fn new(pool_tokens: u64) -> Governor {
        Governor {
            pool_tokens,
            yellow_at: 0.70,
            red_at: 0.90,
            cascade_agents: 3,
            cascade_window_secs: 300,
            grants: BTreeMap::new(),
        }
    }

    /// Does this agent hold an unexpired budget grant? (Restart recovery:
    /// the caller re-grants when this is false — codex P1.)
    pub fn has_live_grant(&self, agent: &str, now_epoch: i64) -> bool {
        self.grants
            .get(agent)
            .map(|g| g.expires_epoch > now_epoch)
            .unwrap_or(false)
    }

    /// Tokens not currently granted out (expired grants return to the pool —
    /// the lease-based reclaim).
    pub fn pool_available(&self, now_epoch: i64) -> u64 {
        let granted: u64 = self
            .grants
            .values()
            .filter(|g| g.expires_epoch > now_epoch)
            .map(|g| g.granted_tokens)
            .sum();
        self.pool_tokens.saturating_sub(granted)
    }

    /// Grant (or renew) an agent's budget lease from the pool. A renewal
    /// replaces the old grant (its remainder frees first); a refused grant
    /// leaves any existing grant untouched.
    pub fn grant(
        &mut self,
        agent: &str,
        tokens: u64,
        lease_secs: i64,
        now_epoch: i64,
    ) -> Result<BudgetGrant, String> {
        let own_live_grant: u64 = self
            .grants
            .get(agent)
            .filter(|g| g.expires_epoch > now_epoch)
            .map(|g| g.granted_tokens)
            .unwrap_or(0);
        let available = self.pool_available(now_epoch) + own_live_grant;
        if tokens > available {
            return Err(format!(
                "pool exhausted: requested {tokens}, available {available}"
            ));
        }
        let g = BudgetGrant {
            agent: agent.to_string(),
            granted_tokens: tokens,
            expires_epoch: now_epoch + lease_secs,
        };
        self.grants.insert(agent.to_string(), g.clone());
        Ok(g)
    }

    pub fn light(&self, agent: &str, usage: &Usage, now_epoch: i64) -> Light {
        let Some(grant) = self
            .grants
            .get(agent)
            .filter(|g| g.expires_epoch > now_epoch)
        else {
            // No live grant = nothing budgeted: red until a grant exists.
            return Light::Red;
        };
        let frac = usage.tokens_spent as f64 / grant.granted_tokens.max(1) as f64;
        if usage.rate_limit_hits > 0 || frac >= self.red_at {
            Light::Red
        } else if frac >= self.yellow_at {
            Light::Yellow
        } else {
            Light::Green
        }
    }

    /// The per-agent decision. Downgrade fires at YELLOW — before the 429 —
    /// and only if a lower tier exists; red pauses dispatch.
    pub fn decide(&self, agent: &str, usage: &Usage, tier: Tier, now_epoch: i64) -> Action {
        match self.light(agent, usage, now_epoch) {
            Light::Green => Action::None,
            Light::Yellow => match tier.downgraded() {
                Some(to) => Action::Downgrade { to },
                // Already on the floor tier: slow down instead.
                None => Action::Throttle { delay_ms: 2000 },
            },
            Light::Red => Action::Pause,
        }
    }

    /// Cascade detection over the whole fleet's usage map.
    pub fn fleet_mode(&self, usages: &BTreeMap<String, Usage>, now_epoch: i64) -> FleetMode {
        let recent = usages
            .values()
            .filter(|u| {
                u.last_rate_limited_epoch > 0
                    && now_epoch - u.last_rate_limited_epoch <= self.cascade_window_secs
            })
            .count();
        if recent >= self.cascade_agents {
            FleetMode::Sequential
        } else {
            FleetMode::Parallel
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(tokens: u64) -> Usage {
        Usage {
            tokens_spent: tokens,
            ..Default::default()
        }
    }

    #[test]
    fn traffic_light_thresholds() {
        let mut g = Governor::new(1_000_000);
        g.grant("janet", 100_000, 3600, 0).unwrap();
        assert_eq!(g.light("janet", &usage(0), 10), Light::Green);
        assert_eq!(g.light("janet", &usage(69_999), 10), Light::Green);
        assert_eq!(g.light("janet", &usage(70_000), 10), Light::Yellow);
        assert_eq!(g.light("janet", &usage(89_999), 10), Light::Yellow);
        assert_eq!(g.light("janet", &usage(90_000), 10), Light::Red);
        // A rate-limit hit is red regardless of spend.
        let hit = Usage {
            tokens_spent: 10,
            rate_limit_hits: 1,
            last_rate_limited_epoch: 5,
            tier: None,
        };
        assert_eq!(g.light("janet", &hit, 10), Light::Red);
        // No grant = red.
        assert_eq!(g.light("ungranted", &usage(0), 10), Light::Red);
    }

    #[test]
    fn downgrade_fires_before_429_and_only_downhill() {
        let mut g = Governor::new(1_000_000);
        g.grant("janet", 100_000, 3600, 0).unwrap();
        assert_eq!(
            g.decide("janet", &usage(10_000), Tier::Opus, 10),
            Action::None
        );
        assert_eq!(
            g.decide("janet", &usage(75_000), Tier::Opus, 10),
            Action::Downgrade { to: Tier::Sonnet }
        );
        assert_eq!(
            g.decide("janet", &usage(75_000), Tier::Sonnet, 10),
            Action::Downgrade { to: Tier::Haiku }
        );
        // Floor tier: throttle instead of a phantom downgrade.
        assert_eq!(
            g.decide("janet", &usage(75_000), Tier::Haiku, 10),
            Action::Throttle { delay_ms: 2000 }
        );
        assert_eq!(
            g.decide("janet", &usage(95_000), Tier::Opus, 10),
            Action::Pause
        );
    }

    #[test]
    fn lease_based_reclaim_returns_expired_grants_to_the_pool() {
        let mut g = Governor::new(100_000);
        g.grant("a", 60_000, 100, 0).unwrap();
        assert_eq!(g.pool_available(50), 40_000);
        // Pool can't over-commit while the lease lives…
        assert!(g.grant("b", 50_000, 100, 50).is_err());
        assert!(g.grant("b", 40_000, 100, 50).is_ok());
        // …and a's unspent grant returns at expiry (reclaim without any call;
        // t=149: a's lease [0,100) is expired, b's [50,150) is still live).
        assert_eq!(g.pool_available(149), 60_000);
        assert!(g.grant("c", 50_000, 100, 149).is_ok());
    }

    #[test]
    fn renewal_replaces_rather_than_stacks() {
        let mut g = Governor::new(100_000);
        g.grant("a", 60_000, 100, 0).unwrap();
        // Renewing down to 30k frees the difference immediately.
        g.grant("a", 30_000, 100, 10).unwrap();
        assert_eq!(g.pool_available(20), 70_000);
        // A renewal may also GROW into its own freed slice (30k held + 70k
        // free = 100k reachable)…
        g.grant("a", 100_000, 100, 20).unwrap();
        assert_eq!(g.pool_available(30), 0);
        // …and a refused over-ask leaves the existing grant untouched.
        let err = g.grant("a", 150_000, 100, 40).unwrap_err();
        assert!(err.contains("pool exhausted"), "{err}");
        assert_eq!(
            g.pool_available(50),
            0,
            "old grant still held after refusal"
        );
        assert_eq!(g.light("a", &usage(0), 50), Light::Green, "grant survived");
    }

    #[test]
    fn cascade_flips_fleet_sequential() {
        let g = Governor::new(1_000_000);
        let mut usages = BTreeMap::new();
        for (agent, hit_at) in [("a", 100i64), ("b", 200), ("c", 250)] {
            usages.insert(
                agent.to_string(),
                Usage {
                    tokens_spent: 0,
                    rate_limit_hits: 1,
                    last_rate_limited_epoch: hit_at,
                    tier: None,
                },
            );
        }
        // All three hits inside the 300s window at t=300 → sequential.
        assert_eq!(g.fleet_mode(&usages, 300), FleetMode::Sequential);
        // At t=500 the t=100 hit has aged out (500-100 > 300) → parallel again.
        assert_eq!(g.fleet_mode(&usages, 500), FleetMode::Parallel);
        // Two hits are below the cascade threshold.
        usages.remove("c");
        assert_eq!(g.fleet_mode(&usages, 300), FleetMode::Parallel);
    }
}
