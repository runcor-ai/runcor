#!/bin/bash
# Runcor Dashboard Simulation — ~100 executions, 5 users, natural pattern
# Action starts IMMEDIATELY. Total runtime ~90 seconds.

BASE="http://localhost:3000"
PIDS=()

connect_user() {
  curl -s -N "$BASE/api/stream?user=$1" > /dev/null 2>&1 &
  PIDS+=($!)
}
disconnect_user() { kill $1 2>/dev/null; }
fire() { curl -s -X POST "$BASE/api/trigger/$1" -H 'Content-Type: application/json' -d "$2" > /dev/null 2>&1 & }

# ═══════════════════════════════════════════════════════════════
# WAVE 1: Morning rush — Sarah + James arrive (0-10s) ~15 execs
# ═══════════════════════════════════════════════════════════════

connect_user "Sarah%20Chen"
sleep 0.2
connect_user "James%20Rodriguez"

fire "lead-qualifier" '{"company":"Morgan Stanley","title":"MD Technology","source":"Davos 2026","notes":"50K employees, AI orchestration for trading"}'
fire "invoice-processor" '{"invoice":"Invoice #4021 CloudStack. License: $24,000. Support: $4,800. Total: $28,800. Net 30."}'
sleep 0.4
fire "expense-validator" '{"employee":"Tom Walsh","department":"Sales","period":"Feb 2026","expenses":"Client dinner: $312\nFlight LAX-JFK: $680\nHotel NYC: $890\nUber: $45"}'
fire "contract-summarizer" '{"contract":"MSA: Runcor and Deloitte. 3yr, $2.4M ACV. 99.95% SLA. SOC2 required. Delaware law."}'
sleep 0.3
fire "sla-monitor" '{"service":"Core Banking","period":"Feb 2026","targets":"Uptime: 99.95%, P1: 15min, API p99: 200ms","metrics":"Uptime: 99.91%, P1: 12min, API p99: 245ms"}'
fire "meeting-notes" '{"transcript":"Standup: Deploy v4.2 today. DB migration scheduled tonight. Lisa covering on-call. Bug #4491 escalated to P2."}'
sleep 0.5
fire "vendor-onboarding" '{"vendor":"DataSync LLC","category":"SaaS Integration","documents":"W-9, SOC2, insurance","value":"$185,000","notes":"Replaces legacy ETL. 3yr contract."}'
fire "lead-qualifier" '{"company":"JPMorgan Chase","title":"SVP Digital Innovation","source":"Inbound Website","notes":"Compliance workflows. 250K employees. RFP Q2."}'
sleep 0.3
fire "expense-validator" '{"employee":"Maria Santos","department":"Product","period":"Feb 2026","expenses":"Conference: $2,500\nFlight SFO-NYC: $520\nHotel 3 nights: $1,350\nTeam lunch: $186"}'
fire "invoice-processor" '{"invoice":"Invoice #7744 NeuralOps. ML Platform: $280,000. Training: $60,000. Tax: $28,900. Total: $368,900. Net 45."}'
sleep 0.4
fire "helpdesk-router" '{"ticket":"Chicago office 12 employees locked out of SAP after MFA rollout. Payroll blocked. Finance director urgent."}'
fire "support-triage" '{"ticket":"Siemens API timeouts since 2am UTC. Manufacturing affected. $50K/hr impact. VP escalating to CEO."}'
sleep 0.3
fire "lead-qualifier" '{"company":"Unilever","title":"CTO","source":"Partner referral","notes":"Consumer goods, 150K employees, digital transformation budget approved"}'
fire "contract-summarizer" '{"contract":"NDA between Runcor and StreamCore Analytics. 2yr mutual. Covers M&A discussions. Carve-out for public info. NY law."}'
fire "sla-monitor" '{"service":"Payment Gateway","period":"Feb 2026","targets":"Uptime: 99.99%, Latency p95: 100ms","metrics":"Uptime: 99.97%, Latency p95: 112ms, 3 degraded periods"}'

# ═══════════════════════════════════════════════════════════════
# WAVE 2: Priya + David join, management layer (10-25s) ~20 execs
# ═══════════════════════════════════════════════════════════════

sleep 2
connect_user "Priya%20Sharma"

fire "team-performance-digest" '{"team":"Platform Engineering","manager":"James Rodriguez","period":"Week Feb 24","metrics":"Velocity: 42pts, PRs: 28, Incidents: 2, Deploys: 4/day","events":"Senior engineer leaving. K8s blocker."}'
fire "budget-variance-analyzer" '{"department":"Product Engineering","quarter":"Q1 2026","budget":"Headcount: $4.2M, Cloud: $890K, Total: $6.3M","actuals":"Headcount: $3.9M, Cloud: $1.12M, Total: $6.3M","priorYear":"Total: $5.1M"}'
sleep 0.5
fire "compliance-checker" '{"document":"Data retention policy v3.1: PII in US-East-1. 7yr retention. Third-party data sharing without consent. SSE-S3 encryption. Email-based access approval."}'
fire "project-status-rollup" '{"portfolio":"Digital Transformation FY26","period":"Feb 2026","projects":"1. Cloud Migration: 65%, delayed. 2. Portal: 40%, over budget. 3. AI Ops: 25%, on track. 4. Legacy Decom: 80%, ahead. 5. Zero Trust: 30%, delayed."}'
sleep 0.6
fire "hiring-pipeline-review" '{"role":"Senior Staff Engineer","candidates":"1. Maria Santos 12yr ex-Google $320K. 2. David Kim 8yr Meta $295K. 3. Priya Sharma 10yr Amazon $305K. 4. Alex Petrov 15yr CTO $280K"}'
fire "risk-register-update" '{"risks":"1. Cloud lock-in L3/I4. 2. CTO dependency L2/I5 sabbatical announced. 3. EU AI Act L4/I3 enforcement moved up. 4. Ransomware L3/I5."}'

sleep 1.5
connect_user "David%20Kim"

fire "expense-validator" '{"employee":"James Rodriguez","department":"Engineering","period":"Feb 2026","expenses":"Team offsite catering: $1,200\nWhiteboard supplies: $89\nAWS training course: $3,500\nUber to datacenter: $62"}'
fire "lead-qualifier" '{"company":"Toyota Motor","title":"VP Manufacturing IT","source":"Existing customer upsell","notes":"Expanding from 1 plant to all 14 NA facilities"}'
sleep 0.4
fire "helpdesk-router" '{"ticket":"VPN disconnecting every 30 minutes for remote employees using macOS 15. Started after Monday network update. 47 tickets filed."}'
fire "vendor-onboarding" '{"vendor":"NeuralOps AI","category":"ML Infrastructure","documents":"W-9, SOC2 pending, insurance cert","value":"$340,000","notes":"Strategic AI vendor. CEO referral. Fast-track."}'
sleep 0.3
fire "invoice-processor" '{"invoice":"Invoice #3312 AWS. EC2: $45,200. S3: $12,100. RDS: $18,400. CloudFront: $3,200. Total: $78,900. Net 30."}'
fire "support-triage" '{"ticket":"Toyota data sync failing between production environments. 3 plants in Japan affected. Regional VP requesting emergency bridge call."}'
sleep 0.5
fire "meeting-notes" '{"transcript":"Architecture Review: Proposed moving to event-driven. Cost savings est $200K/yr. Risk: team unfamiliar with Kafka. Decision: POC in Q2. Action: David to evaluate Kafka vs Pulsar by Mar 14."}'
fire "compliance-checker" '{"document":"Vendor DPA with NeuralOps: Customer data sent to vendor API. EU-West-1 storage. 30-day retention. No DPA signed. Sub-processors undisclosed. 72hr breach notification."}'
sleep 0.4
fire "sla-monitor" '{"service":"Customer Portal","period":"Feb 2026","targets":"Uptime: 99.9%, Page load p95: 3s, Error rate: <1%","metrics":"Uptime: 99.92%, Page load p95: 4.1s, Error rate: 0.8%"}'
fire "team-performance-digest" '{"team":"Data Engineering","manager":"Priya Sharma","period":"Week Feb 24","metrics":"Pipelines: 142 runs, 3 failures. Data freshness: 99.2%. Backfill queue: 8 jobs.","events":"New Snowflake contract signed. Intern starting Monday."}'

# ═══════════════════════════════════════════════════════════════
# WAVE 3: CEO arrives, executive layer fires (25-40s) ~20 execs
# ═══════════════════════════════════════════════════════════════

sleep 2
connect_user "CEO%20-%20Alex%20Torres"

fire "ceo-daily-briefing" '{"date":"2026-02-28","financials":"Revenue run rate $148M. Cash $42M. Burn $2.1M/mo.","operations":"Uptime 99.91%. Cloud migration 65%.","customers":"Won Deloitte $2.4M, Siemens $1.8M. Lost BMW $900K. NPS 62.","people":"CTO sabbatical April. 247 headcount.","external":"EU AI Act. Competitor $200M raise. WSJ inquiry."}'
fire "board-deck-builder" '{"meeting":"Q1 Board Meeting","financials":"Revenue $37.2M +14% YoY, Gross 72%, EBITDA -$2.1M, Cash $42M","strategy":"AI launch Q2. Enterprise +28%. SMB churn 4.2%.","risks":"CTO transition, cloud costs, competition","talent":"18 hires, 12% attrition, engagement 7.2"}'
sleep 0.5
fire "quarterly-earnings-narrative" '{"quarter":"4","year":"2025","revenue":"$37.2M +14% YoY beat","guidance":"FY26 $155-162M","margins":"Gross 72.1%","segments":"Enterprise $28.4M +22%, Mid $6.8M, SMB $2.0M -8%","cash":"$42M 18mo runway","headcount":"247","wins":"Deloitte Siemens Toyota","challenges":"SMB churn, cloud costs, CTO"}'
fire "ma-target-screener" '{"target":"StreamCore Analytics","revenue":"$22M ARR 35% growth","margins":"Gross 78%","technology":"Real-time streaming, Rust, 14 patents","customers":"180 enterprise 45% overlap","team":"85 people","ask":"$180M 8x rev","strategic_fit":"Fills analytics gap"}'
sleep 0.6
fire "market-position-analysis" '{"company":"Runcor","industry":"AI Orchestration","revenue":"$148M","marketShare":"12% of $1.2B","competitors":"CloudRival $200M, DataMind $95M, AgentForge $60M","developments":"Gartner Leader. AWS competing."}'
fire "competitive-intel" '{"intel":"CloudRival $200M Series D $2.1B valuation. Tripling sales. New CTO ex-DeepMind. Multi-agent Q2. 60% discounts. Recruiting our AEs."}'

sleep 1
# Sarah leaves for lunch
disconnect_user ${PIDS[0]}

sleep 0.5
fire "lead-qualifier" '{"company":"Pfizer","title":"Head of Digital R&D","source":"Conference panel","notes":"Drug discovery AI workflows. $500M IT budget. Compliance-heavy."}'
fire "contract-summarizer" '{"contract":"SOW Amendment 3: Runcor-Toyota. Add 13 plants. +$1.8M ACV. Implementation timeline 6 months. Penalty $50K/month delay."}'
sleep 0.4
fire "expense-validator" '{"employee":"Alex Torres","department":"Executive","period":"Feb 2026","expenses":"Board dinner: $4,200\nPrivate car service: $1,800\nDavos travel: $12,500\nClient gifts: $650"}'
fire "invoice-processor" '{"invoice":"Invoice #2289 Deloitte Consulting. Advisory Phase 1: $180,000. Travel: $22,000. Materials: $8,000. Total: $210,000. Net 60."}'
sleep 0.5
fire "helpdesk-router" '{"ticket":"CEO laptop kernel panic. Board meeting in 2 hours. Presentation files on local drive only. Needs immediate replacement or recovery."}'
fire "support-triage" '{"ticket":"Deloitte onboarding team unable to provision API keys. Getting 429 rate limit errors. Go-live scheduled for Monday. $2.4M contract at risk."}'

# ═══════════════════════════════════════════════════════════════
# WAVE 4: Midday burst — high activity (40-55s) ~20 execs
# ═══════════════════════════════════════════════════════════════

sleep 2
fire "budget-variance-analyzer" '{"department":"Sales","quarter":"Q1 2026","budget":"Commissions: $1.8M, Events: $400K, Tools: $200K, Total: $2.4M","actuals":"Commissions: $2.1M, Events: $350K, Tools: $220K, Total: $2.67M","priorYear":"Total: $1.9M"}'
fire "project-status-rollup" '{"portfolio":"Security Initiatives","period":"Feb 2026","projects":"1. Zero Trust: 30%, delayed vendor. 2. SOC2 Recert: 60%, on track. 3. Pen Testing: completed. 4. SIEM Upgrade: 15%, just started."}'
sleep 0.3
fire "hiring-pipeline-review" '{"role":"VP of Sales EMEA","candidates":"1. Klaus Weber 18yr SAP/Oracle background $450K. 2. Sophie Dubois 15yr Salesforce/Datadog $420K. 3. Henrik Nilsson 20yr enterprise SaaS $400K"}'
fire "risk-register-update" '{"risks":"Updated after board prep: CTO now L4/I5. EU AI Act L5/I4 imminent. New: Toyota relationship L3/I4. New: talent retention L4/I3 (3 senior departures). Closed: competitor breach - mitigated."}'
sleep 0.5

# David leaves
disconnect_user ${PIDS[3]}

fire "compliance-checker" '{"document":"AI model training policy draft: Production customer data used for model fine-tuning. Opt-out mechanism via settings page. Training data retained indefinitely. No bias testing documented. Model outputs not logged for audit."}'
fire "vendor-onboarding" '{"vendor":"SecureAuth Global","category":"Identity Security","documents":"W-9, SOC2 Type II, FedRAMP moderate, cyber insurance","value":"$520,000","notes":"Replacing Okta for Zero Trust initiative. 3yr deal."}'
sleep 0.4
fire "lead-qualifier" '{"company":"Siemens Energy","title":"CIO","source":"Existing relationship expansion","notes":"Separate BU from Siemens AG. Wind turbine manufacturing. 90K employees."}'
fire "lead-qualifier" '{"company":"Goldman Sachs","title":"Partner, Technology Division","source":"Board member intro","notes":"Trading floor AI. Ultra-low latency requirements. $1B+ tech budget."}'
sleep 0.3
fire "meeting-notes" '{"transcript":"Sales forecast review. Pipeline $31M weighted. Q1 close likely $38M vs $36M target. Deals at risk: BMW renewal ($900K), Spotify eval ($600K). Upside: Goldman intro could be $5M+. Action: CRO to fly to Munich for BMW save. Action: SE team demo for Goldman by Mar 12."}'
fire "invoice-processor" '{"invoice":"Invoice #1190 Sequoia Legal. M&A advisory retainer: $75,000/month. Due diligence phase 1: $120,000. Total: $195,000. Net 15."}'
sleep 0.5
fire "sla-monitor" '{"service":"ML Inference API","period":"Feb 2026","targets":"Latency p99: 500ms, Throughput: 1000 req/s, Error rate: <0.5%","metrics":"Latency p99: 620ms, Throughput: 850 req/s, Error rate: 0.3%"}'
fire "support-triage" '{"ticket":"Multiple enterprise customers reporting slow dashboard loading. Performance degraded 40% since last deploy. Affecting 12 accounts. Rollback being considered."}'
sleep 0.3
fire "contract-summarizer" '{"contract":"Cloud Service Agreement: AWS Enterprise. 3yr commit $4.2M. Reserved instances: 40% discount. Egress: standard rates. Support: Enterprise tier. Credits: $200K migration. Termination: 12mo remaining commitment."}'
fire "expense-validator" '{"employee":"Sophie Laurent","department":"Marketing","period":"Feb 2026","expenses":"Google Ads: $45,000\nTrade show booth: $28,000\nVideo production: $12,000\nSwag: $5,500\nDinner event 80 ppl: $8,200"}'
sleep 0.4
fire "helpdesk-router" '{"ticket":"Production database replica lag exceeded 30 seconds. Alerting on all monitors. Read queries serving stale data. Customer-facing reports affected."}'
fire "team-performance-digest" '{"team":"Security Engineering","manager":"Wei Zhang","period":"Week Feb 24","metrics":"Vulnerabilities closed: 14/18, Mean time to patch: 4.2 days, Pen test findings: 3 critical resolved.","events":"Zero Trust pilot started. New SIEM vendor selected. Security awareness training 89% completion."}'

# ═══════════════════════════════════════════════════════════════
# WAVE 5: Afternoon — Sarah returns, final burst (55-75s) ~20 execs
# ═══════════════════════════════════════════════════════════════

sleep 3
connect_user "Sarah%20Chen"

fire "ceo-daily-briefing" '{"date":"2026-03-01","financials":"Feb close: $12.8M +3% MoM. Pipeline $31M.","operations":"P1s resolved. Cloud migration 70%.","customers":"Siemens resolved. Toyota bridge scheduled. Goldman intro confirmed.","people":"3 Staff promotions today. Acting CTO plan drafted.","external":"WSJ delayed. EU working group formed."}'
fire "ma-target-screener" '{"target":"AgentForge Labs","revenue":"$60M ARR 25% growth","margins":"Gross 65% EBITDA 5%","technology":"Open-source agent framework, Python, large community","customers":"2400 companies mostly dev-tier, 120 enterprise","team":"200 employees","ask":"$400M","strategic_fit":"Would gain open-source community and Python ecosystem presence"}'
sleep 0.5
fire "lead-qualifier" '{"company":"HSBC","title":"Group CTO","source":"RFI received","notes":"Global banking. 220K employees. Looking for AI governance platform. Compliance-first."}'
fire "compliance-checker" '{"document":"HSBC RFI response draft: Claims SOC2 Type II (valid), ISO 27001 (expired 2025), GDPR compliant (no DPO appointed), data residency any region (HSBC requires UK/EU only)."}'
sleep 0.4
fire "budget-variance-analyzer" '{"department":"Marketing","quarter":"Q1 2026","budget":"Digital: $180K, Events: $320K, Content: $90K, Brand: $60K, Total: $650K","actuals":"Digital: $210K, Events: $280K, Content: $105K, Brand: $45K, Total: $640K","priorYear":"Total: $520K"}'
fire "hiring-pipeline-review" '{"role":"Chief of Staff to CEO","candidates":"1. Rachel Kim internal transfer 6yr at company. 2. Marcus Johnson ex-McKinsey $280K. 3. Aisha Patel ex-Stripe ops leader $310K"}'
sleep 0.6

# Priya leaves
disconnect_user ${PIDS[2]}

fire "project-status-rollup" '{"portfolio":"AI Product Suite","period":"March 2026","projects":"1. Agent Orchestrator v2: 55%, on track for Q2. 2. Model Router: 90%, shipping next week. 3. Eval Framework: 35%, on track. 4. MCP Marketplace: 10%, just kicked off."}'
fire "risk-register-update" '{"risks":"Monthly update: CTO dep L4/I5 mitigated by acting CTO plan. EU AI Act L5/I4 working group formed. Toyota L2/I4 bridge call positive. New: AWS competing service L3/I4. New: key account churn signal L3/I3 (BMW, Spotify)."}'
sleep 0.4
fire "invoice-processor" '{"invoice":"Invoice #5501 Google Cloud. GKE: $32,000. BigQuery: $18,500. Vertex AI: $24,000. Networking: $5,500. Total: $80,000. Net 30."}'
fire "vendor-onboarding" '{"vendor":"Anthropic Inc","category":"AI Model Provider","documents":"W-9, Terms of Service, Usage Policy, SOC2 Type II","value":"$600,000","notes":"Primary model provider. Volume pricing negotiated. Enterprise agreement."}'
sleep 0.3
fire "support-triage" '{"ticket":"Goldman Sachs POC environment provisioning request. Board member connection. Need dedicated instance with enhanced security. Target: operational by Mar 10."}'
fire "meeting-notes" '{"transcript":"M&A discussion: StreamCore at 8x is fair for 35% growth. AgentForge at 6.7x overpriced for 25% growth. Decision: proceed with StreamCore LOI. Action: CFO prepare financing scenarios. Action: Legal start due diligence. Action: CTO (before sabbatical) do technical assessment by Mar 20."}'
sleep 0.5
fire "competitive-intel" '{"intel":"AWS re:Invent late announcement: managed AI orchestration service launching Q3. Free tier included with Enterprise Support. Targets mid-market. Our enterprise moat remains but mid-market at risk. DataMind responded with price cut."}'
fire "lead-qualifier" '{"company":"US Department of Defense","title":"Program Manager JAIC","source":"GovCloud partner referral","notes":"FedRAMP High required. AI orchestration for logistics. Multi-year IDIQ vehicle. $10M ceiling."}'
fire "contract-summarizer" '{"contract":"LOI: Runcor to acquire StreamCore Analytics. Price $165-180M. Structure: 70% cash 30% stock. Key employee retention 2yr. Exclusivity 60 days. Due diligence 45 days. Breakup fee 3%."}'
fire "expense-validator" '{"employee":"David Kim","department":"Engineering","period":"Feb 2026","expenses":"Home office monitor: $800\nMechanical keyboard: $350\nO Reilly subscription: $499\nCoworking space: $450\nTeam happy hour: $380"}'

# ═══════════════════════════════════════════════════════════════
# WIND DOWN: Users leave (75-90s) ~5 final execs
# ═══════════════════════════════════════════════════════════════

sleep 4
fire "quarterly-earnings-narrative" '{"quarter":"1","year":"2026","revenue":"$38.1M +16% YoY","guidance":"Raising FY26 to $158-165M","margins":"Gross 72.4% +210bps","segments":"Enterprise $29.8M +26%, Mid $7.1M +8%, SMB $1.2M winding down","cash":"$39M post StreamCore LOI","headcount":"251","wins":"Goldman, HSBC, DoD pipeline","challenges":"M&A integration planning, acting CTO transition, AWS competition"}'
fire "board-deck-builder" '{"meeting":"Emergency Board Update - StreamCore Acquisition","financials":"Deal: $165-180M, 70/30 cash/stock. Funding: $60M cash + $80M debt facility + equity","strategy":"Fills real-time analytics gap. Combined ARR $170M. Cross-sell to 45% overlapping customers.","risks":"Integration complexity, key person retention, Rust expertise gap","talent":"85 StreamCore employees, plan to retain 90%+, 2yr retention packages"}'

sleep 2
disconnect_user ${PIDS[1]}
sleep 2

fire "ceo-daily-briefing" '{"date":"2026-03-01","financials":"StreamCore LOI signed. Board emergency session scheduled. Feb close strong at $38.1M.","operations":"All systems green. Migration 70%.","customers":"Goldman POC approved. HSBC RFI submitted. DoD opportunity surfaced.","people":"Acting CTO effective April 1. Staff promotions announced.","external":"AWS competing service confirmed Q3. StreamCore deal confidential until close."}'

sleep 3
disconnect_user ${PIDS[4]}
sleep 2
disconnect_user ${PIDS[5]}

echo "=== Simulation complete: ~100 executions across 5 users ==="

for pid in "${PIDS[@]}"; do kill $pid 2>/dev/null; done
wait 2>/dev/null
