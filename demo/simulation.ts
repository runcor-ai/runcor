// Demo simulation module — activated by DEMO_MODE=true
// Registers 95 business flows and runs continuous simulated activity.

import type { FlowHandler } from '../src/types.js';
import type { MockProvider } from '../src/model/mock.js';

type Engine = {
  register(name: string, handler: FlowHandler, config?: Record<string, unknown>): void;
  trigger(flowName: string, options: Record<string, unknown>): Promise<unknown>;
  runDiscernmentCycle(): Promise<unknown>;
};
type AgentHandlerFactory = (config: { systemPrompt: string; maxIterations: number }) => FlowHandler;

// ── Helpers ──────────────────────────────────────────────────────────────────

const pk = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const ri = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const rid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const rdate = () => {
  const d = new Date();
  d.setDate(d.getDate() - ri(0, 30));
  return d.toISOString().split('T')[0];
};
const money = (min: number, max: number) => `$${ri(min, max).toLocaleString()}`;

// ── Data Pools ───────────────────────────────────────────────────────────────

const vendors = ['Acme Corp', 'TechVentures Inc', 'Global Logistics LLC', 'Pinnacle Systems', 'Atlas Cloud Services', 'Meridian Consulting', 'Vertex Software', 'Summit Analytics', 'CoreTech Solutions', 'Nexus Partners'];
const companies = ['Orion Health', 'Stellar Dynamics', 'BluePeak Financial', 'Quantum Retail', 'Prism Mfg', 'Apex Biotech', 'Helios Energy', 'Catalyst Education', 'Forge Aerospace', 'Tidal Commerce'];
const people = ['Sarah Chen', 'James Patel', 'Maria Lopez', 'David Kim', 'Emily Watson', 'Michael Torres', 'Rachel Green', 'Alex Johnson', 'Priya Sharma', 'Tom Anderson', 'Lisa Park', 'Chris Rivera'];
const products = ['Enterprise Suite', 'Developer Platform', 'Analytics Pro', 'Security Shield', 'Integration Hub', 'Data Warehouse', 'Mobile SDK', 'Cloud Gateway'];
const depts = ['Engineering', 'Sales', 'Marketing', 'Finance', 'HR', 'Operations', 'Legal', 'Support'];
const regions = ['North America', 'EMEA', 'APAC', 'LATAM'];
const roles = ['Senior Engineer', 'Product Manager', 'Data Scientist', 'UX Designer', 'DevOps Lead', 'QA Manager', 'Frontend Dev', 'Backend Engineer', 'Engineering Manager', 'Staff Engineer'];
const skills = ['TypeScript', 'Python', 'React', 'AWS', 'Kubernetes', 'Machine Learning', 'System Design', 'GraphQL', 'Rust', 'Go'];
const severities = ['Critical', 'High', 'Medium', 'Low'];
const channels = ['Email', 'Chat', 'Phone', 'Web Form', 'Social Media'];
const industries = ['Healthcare', 'Financial Services', 'Retail', 'Manufacturing', 'Technology', 'Education', 'Energy', 'Government'];
const tickets = ['Cannot log in after password reset', 'Dashboard loading slowly', 'Export to CSV broken', 'Billing discrepancy on last invoice', 'API rate limit errors in production', 'SSO integration not working', 'Missing data in monthly report', 'Mobile app crash on launch', 'Webhook delivery failures', 'Permission denied accessing shared workspace'];
const repos = ['api-gateway', 'web-dashboard', 'mobile-app', 'auth-service', 'billing-engine', 'analytics-pipeline', 'notification-service', 'search-indexer', 'data-platform', 'infrastructure'];
const regulations = ['SOC 2 Type II', 'GDPR Article 17', 'HIPAA §164.312', 'PCI DSS v4.0', 'CCPA §1798.100', 'ISO 27001:2022', 'SOX Section 404', 'FedRAMP Moderate'];
const campaignTypes = ['Product Launch', 'Brand Awareness', 'Lead Generation', 'Customer Retention', 'Event Promotion', 'Thought Leadership'];
const contentTypes = ['Blog Post', 'Case Study', 'Whitepaper', 'Webinar', 'Infographic', 'Video Script'];

// ── Department Contexts (prepended to every prompt for token depth) ─────────

const ctx: Record<string, string> = {
  finance: 'You are a senior financial analyst in the corporate finance division of a Fortune 500 technology company with 12 years of experience in corporate accounting, financial planning & analysis, and regulatory compliance. You work closely with the CFO office and ensure financial accuracy across all operations. Always include specific numbers, variance calculations, risk ratings (1-10), and clear actionable recommendations. Reference GAAP/IFRS standards where applicable.',
  sales: 'You are a senior sales strategist at a high-growth B2B SaaS company generating $80M ARR. You specialize in enterprise pipeline management, competitive intelligence, and revenue optimization. Your analysis must be data-driven with conversion metrics, deal velocity benchmarks, risk factors, and specific next steps. Reference industry benchmarks where relevant.',
  hr: 'You are a senior HR business partner supporting a 2,000-person technology organization across four global offices. You have deep expertise in talent acquisition, organizational development, compensation strategy, and employment law compliance. Your recommendations must balance business needs with employee experience, include market data, and reference relevant labor regulations.',
  marketing: 'You are a senior marketing strategist at a B2B SaaS company competing in a crowded market. You have expertise in demand generation, content marketing, brand strategy, and marketing analytics. Always reference specific KPIs (CAC, LTV, MQL-to-SQL conversion), competitive positioning, and channel-specific benchmarks in your analysis.',
  legal: 'You are senior legal counsel at a technology company operating in 12 jurisdictions. You specialize in commercial contracts, intellectual property, data privacy, and regulatory compliance. Your analysis must identify specific risk areas, reference applicable statutes or regulations, provide risk scores (1-10), and recommend concrete mitigation strategies.',
  support: 'You are a senior customer support operations manager overseeing a team of 45 agents handling 3,000+ tickets per month across enterprise and SMB segments. You focus on CSAT optimization, ticket deflection, escalation prevention, and churn reduction. Always include sentiment indicators, SLA metrics, priority classification, and specific response frameworks.',
  engineering: 'You are a senior engineering manager responsible for platform reliability and developer productivity across 8 product teams. You have deep expertise in system architecture, incident management, technical debt quantification, and deployment safety. Always include severity assessments, blast radius analysis, specific metrics (MTTR, change failure rate), and prioritized action items.',
  operations: 'You are a senior operations director managing cross-functional programs, vendor relationships, and organizational efficiency at a scaling technology company. You specialize in process optimization, resource planning, risk management, and KPI frameworks. Always include quantified impact estimates, timeline recommendations, dependency mapping, and stakeholder communication plans.',
};

// ── Flow Definition Types ────────────────────────────────────────────────────

interface PFlowDef {
  name: string;
  desc: string;
  tpl: string;
  gen: () => Record<string, unknown>;
}

interface AFlowDef {
  name: string;
  desc: string;
  objective: string;
  systemPrompt: string;
  maxIterations: number;
  gen: () => Record<string, unknown>;
}

// ── Prompt Flow Definitions (80 flows, 8 departments × 10) ──────────────────

const deptFlows: Record<string, { objective: string; flows: PFlowDef[] }> = {
  finance: {
    objective: 'cost-optimization',
    flows: [
      { name: 'invoice-processor', desc: 'Validate incoming invoices against PO records',
        tpl: 'Review invoice {{invoiceId}} from {{vendor}} for {{amount}} charged to {{costCenter}} on {{date}}. Validate: vendor in approved registry, amount within 5% of PO, no duplicates in 90 days, correct tax calculation, proper GL coding, and flag items over $10,000 single-approval threshold. Provide PASS/FAIL per check, risk score 1-10, and recommendation: APPROVE, HOLD, or REJECT with justification.',
        gen: () => ({ invoiceId: `INV-${ri(10000, 99999)}`, vendor: pk(vendors), amount: money(500, 75000), costCenter: pk(depts), date: rdate() }) },
      { name: 'budget-variance-analyzer', desc: 'Analyze budget variances by department and period',
        tpl: 'Analyze budget variance for {{department}} in {{period}}. Budgeted: {{budgeted}}, Actual: {{actual}}, Variance: {{variance}}. Identify top 3 variance drivers, classify each as one-time or recurring, assess impact on annual forecast, and recommend corrective actions with projected savings.',
        gen: () => ({ department: pk(depts), period: `Q${ri(1, 4)} 2026`, budgeted: money(100000, 500000), actual: money(80000, 600000), variance: `${ri(-25, 25)}%` }) },
      { name: 'expense-approver', desc: 'Review and approve employee expense reports',
        tpl: 'Review expense report {{reportId}} from {{employee}} ({{department}}). Total: {{total}}, {{itemCount}} line items, submitted {{date}}. Top items: {{topItems}}. Check against expense policy: per-diem limits, receipt requirements, pre-approval for items over $500, prohibited categories, and timely submission (within 30 days). Approve, return for revision, or escalate.',
        gen: () => ({ reportId: `EXP-${ri(1000, 9999)}`, employee: pk(people), department: pk(depts), total: money(200, 8000), itemCount: ri(3, 15), date: rdate(), topItems: `${pk(['Hotel', 'Flight', 'Client dinner', 'Conference', 'Software license'])} (${money(100, 3000)})` }) },
      { name: 'cash-flow-summary', desc: 'Generate cash flow summary and projections',
        tpl: 'Generate cash flow summary for {{period}}. Opening balance: {{opening}}. Receivables: {{receivables}}, Payables: {{payables}}, Payroll: {{payroll}}, CapEx: {{capex}}. Project closing balance, identify potential shortfalls in next 90 days, flag any covenant risks, and recommend actions to optimize working capital.',
        gen: () => ({ period: `${pk(['January', 'February', 'March', 'April', 'May', 'June'])} 2026`, opening: money(500000, 2000000), receivables: money(200000, 800000), payables: money(150000, 600000), payroll: money(300000, 500000), capex: money(50000, 200000) }) },
      { name: 'payroll-checker', desc: 'Validate payroll calculations before processing',
        tpl: 'Validate payroll run for {{period}} covering {{headcount}} employees. Gross payroll: {{gross}}, Deductions: {{deductions}}, Net: {{net}}. Flagged items: {{flags}}. Verify tax withholding rates, benefit deductions, overtime calculations, and new hire/termination prorations. Report discrepancies with affected employees.',
        gen: () => ({ period: `${pk(['Jan', 'Feb', 'Mar', 'Apr'])} 2026`, headcount: ri(180, 220), gross: money(800000, 1200000), deductions: money(200000, 400000), net: money(600000, 900000), flags: `${ri(1, 5)} items flagged (${pk(['overtime variance', 'new hire proration', 'benefit change', 'tax rate update'])})` }) },
      { name: 'tax-estimate', desc: 'Calculate quarterly tax estimates',
        tpl: 'Estimate quarterly taxes for {{quarter}} 2026. Revenue: {{revenue}}, COGS: {{cogs}}, Operating expenses: {{opex}}, Jurisdictions: {{jurisdictions}}. Calculate federal, state, and local tax liability estimates. Factor in R&D credits, depreciation schedules, and any carry-forward losses. Provide estimated payment amounts by jurisdiction.',
        gen: () => ({ quarter: `Q${ri(1, 4)}`, revenue: money(5000000, 15000000), cogs: money(1000000, 4000000), opex: money(2000000, 6000000), jurisdictions: `${pk(['CA', 'NY', 'TX', 'WA', 'DE'])}, Federal` }) },
      { name: 'vendor-payment-validator', desc: 'Validate vendor payment batch before release',
        tpl: 'Validate payment batch {{batchId}} containing {{count}} payments totaling {{total}}. Largest payment: {{largest}} to {{vendor}}. Verify: all invoices approved, no duplicate payments, bank details match vendor master, payment terms respected, and aggregate limits not exceeded. Flag any anomalies.',
        gen: () => ({ batchId: `BATCH-${ri(100, 999)}`, count: ri(15, 80), total: money(50000, 500000), largest: money(10000, 100000), vendor: pk(vendors) }) },
      { name: 'financial-forecast', desc: 'Generate rolling financial forecast',
        tpl: 'Generate 6-month rolling forecast starting {{startMonth}}. Current run rate: {{runRate}}/month. Known changes: {{changes}}. Model three scenarios (conservative, base, optimistic) for revenue, expenses, and EBITDA. Include key assumptions, sensitivity analysis on top 3 variables, and confidence intervals.',
        gen: () => ({ startMonth: pk(['April', 'May', 'June', 'July']), runRate: money(1000000, 3000000), changes: pk(['New enterprise deal closing Q2', 'Headcount freeze lifted', 'Price increase effective May', 'Vendor contract renegotiation']) }) },
      { name: 'capex-reviewer', desc: 'Review capital expenditure requests',
        tpl: 'Review CapEx request {{requestId}} from {{department}}: {{description}}. Requested amount: {{amount}}, Expected useful life: {{life}} years, Projected ROI: {{roi}}. Evaluate: strategic alignment, payback period, alternative options (lease vs buy), budget availability, and approval threshold. Recommend approve, defer, or reject with rationale.',
        gen: () => ({ requestId: `CAPEX-${ri(100, 999)}`, department: pk(depts), description: pk(['Server infrastructure upgrade', 'Office renovation', 'Lab equipment', 'Security system overhaul', 'Fleet vehicle replacement']), amount: money(25000, 500000), life: ri(3, 7), roi: `${ri(8, 35)}%` }) },
      { name: 'audit-log-summarizer', desc: 'Summarize audit log entries for compliance',
        tpl: 'Summarize audit log for {{system}} from {{startDate}} to {{endDate}}. Total events: {{eventCount}}. Flagged events: {{flagged}}. Categories: {{categories}}. Identify unusual patterns, access anomalies, policy violations, and segregation-of-duties conflicts. Provide executive summary suitable for external auditors.',
        gen: () => ({ system: pk(['ERP', 'CRM', 'HRIS', 'Treasury', 'Procurement']), startDate: rdate(), endDate: rdate(), eventCount: ri(5000, 50000), flagged: ri(3, 25), categories: 'Login, Data Export, Config Change, Permission Grant, Record Deletion' }) },
    ],
  },
  sales: {
    objective: 'revenue-growth',
    flows: [
      { name: 'lead-qualifier', desc: 'Qualify inbound leads using BANT criteria',
        tpl: 'Qualify this inbound lead: Company: {{company}} ({{industry}}, {{size}} employees). Contact: {{contact}}, {{title}}. Source: {{source}}. Notes: "{{notes}}". Score using BANT framework (Budget, Authority, Need, Timeline). Assign priority (Hot/Warm/Cold), recommend next action, and suggest ideal AE assignment based on territory and vertical.',
        gen: () => ({ company: pk(companies), industry: pk(industries), size: ri(50, 5000), contact: pk(people), title: pk(['VP Engineering', 'CTO', 'Director of IT', 'Head of Product', 'CEO']), source: pk(['Website demo request', 'Webinar attendee', 'G2 comparison', 'Referral', 'LinkedIn ad']), notes: pk(['Looking to replace current vendor', 'Evaluating 3 solutions', 'Need implementation by Q3', 'Budget approved for this quarter']) }) },
      { name: 'deal-scorer', desc: 'Score deal probability and recommend actions',
        tpl: 'Score deal {{dealId}}: {{company}} ({{industry}}). Stage: {{stage}}, Amount: {{amount}}, Age: {{age}} days. Champion: {{champion}}. Competitors: {{competitors}}. Last activity: {{lastActivity}}. Calculate win probability (0-100%), identify top 3 risks, suggest specific actions to advance, and flag if deal needs executive sponsor engagement.',
        gen: () => ({ dealId: `DEAL-${ri(1000, 9999)}`, company: pk(companies), industry: pk(industries), stage: pk(['Discovery', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost']), amount: money(25000, 500000), age: ri(5, 120), champion: pk(people), competitors: pk(vendors), lastActivity: pk(['Demo completed', 'Proposal sent', 'Contract redlined', 'Pricing discussion', 'No response 14 days']) }) },
      { name: 'proposal-generator', desc: 'Generate customized sales proposals',
        tpl: 'Generate proposal for {{company}} ({{industry}}, {{size}} employees). Products: {{products}}. Use case: {{useCase}}. Contract: {{term}} months, Value: {{amount}}. Key stakeholders: {{stakeholders}}. Include executive summary, solution overview, implementation timeline, pricing breakdown, ROI projection, and competitive differentiation.',
        gen: () => ({ company: pk(companies), industry: pk(industries), size: ri(100, 10000), products: `${pk(products)}, ${pk(products)}`, useCase: pk(['Workflow automation', 'Data consolidation', 'Customer analytics', 'Security compliance', 'Developer productivity']), term: pk([12, 24, 36]), amount: money(50000, 300000), stakeholders: `${pk(people)} (Sponsor), ${pk(people)} (Technical)` }) },
      { name: 'competitor-analyzer', desc: 'Analyze competitive positioning for a deal',
        tpl: 'Analyze competitive positioning against {{competitor}} for deal with {{company}}. Our offering: {{product}} at {{ourPrice}}/year. Competitor offering: {{theirProduct}} at {{theirPrice}}/year. Customer priorities: {{priorities}}. Compare: feature parity, pricing model, implementation complexity, support quality, and ecosystem integrations. Provide battlecard-style talking points.',
        gen: () => ({ competitor: pk(vendors), company: pk(companies), product: pk(products), ourPrice: money(30000, 200000), theirProduct: pk(['Competitor Suite', 'Alternative Platform', 'Legacy System', 'Open Source + Support']), theirPrice: money(20000, 180000), priorities: pk(['Time to value', 'Total cost of ownership', 'Enterprise security', 'API extensibility', 'Customer support']) }) },
      { name: 'pipeline-summary', desc: 'Summarize sales pipeline health and forecast',
        tpl: 'Summarize pipeline for {{region}} region, {{quarter}}. Total pipeline: {{total}} across {{dealCount}} deals. By stage: Discovery {{discovery}}, Qualified {{qualified}}, Proposal {{proposal}}, Negotiation {{negotiation}}. Quota: {{quota}}. Assess coverage ratio, identify at-risk deals, forecast likely attainment, and recommend pipeline generation priorities.',
        gen: () => ({ region: pk(regions), quarter: `Q${ri(1, 4)} 2026`, total: money(2000000, 8000000), dealCount: ri(20, 80), discovery: money(500000, 2000000), qualified: money(400000, 1500000), proposal: money(300000, 1200000), negotiation: money(200000, 800000), quota: money(1500000, 4000000) }) },
      { name: 'win-loss-analyzer', desc: 'Analyze recent win/loss patterns',
        tpl: 'Analyze {{outcome}} of deal {{dealId}} with {{company}} ({{industry}}). Amount: {{amount}}, Sales cycle: {{days}} days. Primary competitor: {{competitor}}. Decision factors cited by customer: {{factors}}. Identify patterns with similar deals, extract lessons, and recommend process improvements.',
        gen: () => ({ outcome: pk(['win', 'loss']), dealId: `DEAL-${ri(1000, 9999)}`, company: pk(companies), industry: pk(industries), amount: money(30000, 300000), days: ri(30, 180), competitor: pk(vendors), factors: pk(['Price', 'Feature gaps', 'Implementation timeline', 'References', 'Security certifications', 'Executive relationship']) }) },
      { name: 'outreach-drafter', desc: 'Draft personalized sales outreach emails',
        tpl: 'Draft outreach email to {{contact}} ({{title}}) at {{company}} ({{industry}}, {{size}} employees). Context: {{context}}. Trigger event: {{trigger}}. Our relevant product: {{product}}. Write a concise, personalized email that references their specific situation, articulates relevant value prop, and includes a clear CTA. Avoid generic language.',
        gen: () => ({ contact: pk(people), title: pk(['VP Engineering', 'CTO', 'Director of IT', 'Head of Product']), company: pk(companies), industry: pk(industries), size: ri(100, 5000), context: pk(['Cold outreach', 'Follow-up after webinar', 'Re-engagement after 6 months', 'Referral introduction']), trigger: pk(['Recent funding round', 'Job posting for our category', 'Competitor contract expiring', 'Conference attendee', 'Published article on related topic']), product: pk(products) }) },
      { name: 'renewal-reminder', desc: 'Generate renewal reminders with expansion opportunities',
        tpl: 'Generate renewal analysis for {{company}}. Contract: {{contractId}}, Value: {{amount}}/year, Renewal date: {{renewalDate}}. Usage: {{usage}}. Health score: {{health}}/100. Support tickets: {{ticketCount}} in last 90 days. Identify renewal risk level, expansion opportunities, recommended pricing adjustment, and talking points for renewal conversation.',
        gen: () => ({ company: pk(companies), contractId: `CTR-${ri(1000, 9999)}`, amount: money(20000, 200000), renewalDate: rdate(), usage: `${ri(40, 100)}% of licensed capacity`, health: ri(30, 98), ticketCount: ri(0, 15) }) },
      { name: 'pricing-optimizer', desc: 'Optimize pricing strategy for deal',
        tpl: 'Optimize pricing for {{company}} deal. Products: {{products}}. List price: {{listPrice}}, Requested discount: {{discount}}. Deal size: {{seats}} seats, Term: {{term}} months. Similar deals closed at: {{benchmark}} average discount. Customer leverage: {{leverage}}. Recommend pricing strategy, acceptable discount range, and value-add alternatives to discounting.',
        gen: () => ({ company: pk(companies), products: pk(products), listPrice: money(50000, 300000), discount: `${ri(5, 35)}%`, seats: ri(20, 500), term: pk([12, 24, 36]), benchmark: `${ri(10, 25)}%`, leverage: pk(['Single vendor evaluation', 'Competitive bake-off', 'Existing customer expansion', 'Multi-year commitment possible']) }) },
      { name: 'sales-forecast', desc: 'Generate weekly sales forecast',
        tpl: 'Generate sales forecast for {{period}}. Commit: {{commit}} ({{commitCount}} deals), Best case: {{bestCase}} ({{bestCount}} deals), Pipeline: {{pipeline}} ({{pipeCount}} deals). Last week\'s forecast accuracy: {{accuracy}}%. Notable changes: {{changes}}. Provide updated forecast with confidence levels, call out risk/upside deals, and recommend forecast adjustments.',
        gen: () => ({ period: `Week of ${rdate()}`, commit: money(500000, 2000000), commitCount: ri(5, 15), bestCase: money(800000, 3000000), bestCount: ri(8, 25), pipeline: money(2000000, 6000000), pipeCount: ri(20, 60), accuracy: ri(70, 95), changes: pk(['$200K deal slipped to next quarter', 'New $150K deal added to commit', 'Key competitor acquired', 'Champion left the company']) }) },
    ],
  },
  hr: {
    objective: 'talent-acquisition',
    flows: [
      { name: 'job-description-writer', desc: 'Write compelling job descriptions',
        tpl: 'Write job description for {{role}} in {{department}} ({{location}}). Level: {{level}}. Team size: {{teamSize}}. Key requirements: {{requirements}}. Compensation range: {{comp}}. Include role summary, responsibilities, requirements, nice-to-haves, benefits highlights, and DEI statement. Optimize for inclusive language and SEO.',
        gen: () => ({ role: pk(roles), department: pk(depts), location: pk(['San Francisco, CA', 'New York, NY', 'Austin, TX', 'Remote US', 'London, UK']), level: pk(['IC3', 'IC4', 'IC5', 'M1', 'M2']), teamSize: ri(4, 20), requirements: `${pk(skills)}, ${pk(skills)}, ${ri(3, 10)}+ years experience`, comp: `${money(120000, 250000)} - ${money(180000, 350000)}` }) },
      { name: 'resume-screener', desc: 'Screen resumes against job requirements',
        tpl: 'Screen resume for {{role}} position. Candidate: {{candidate}}. Experience: {{years}} years. Current company: {{company}} ({{industry}}). Key skills: {{skills}}. Education: {{education}}. Requirements match: evaluate technical skills alignment, experience level, industry relevance, and growth trajectory. Score 1-100, classify as Advance/Hold/Reject, and note any concerns or standout qualities.',
        gen: () => ({ role: pk(roles), candidate: pk(people), years: ri(2, 15), company: pk(companies), industry: pk(industries), skills: `${pk(skills)}, ${pk(skills)}, ${pk(skills)}`, education: pk(['BS Computer Science, Stanford', 'MS Data Science, MIT', 'BA Business, NYU', 'PhD ML, CMU', 'Bootcamp + 5 years experience']) }) },
      { name: 'onboarding-checklist', desc: 'Generate personalized onboarding checklist',
        tpl: 'Generate onboarding checklist for {{name}} starting as {{role}} in {{department}} on {{startDate}}. Manager: {{manager}}. Location: {{location}}. Pre-start, Week 1, 30/60/90 day milestones. Include: IT setup, security training, compliance modules, team introductions, shadowing schedule, and role-specific deliverables.',
        gen: () => ({ name: pk(people), role: pk(roles), department: pk(depts), startDate: rdate(), manager: pk(people), location: pk(['Office - SF', 'Office - NYC', 'Remote', 'Hybrid']) }) },
      { name: 'performance-reviewer', desc: 'Analyze performance review data and draft feedback',
        tpl: 'Analyze performance data for {{employee}} ({{role}}, {{department}}). Review period: {{period}}. Self-assessment highlights: {{selfAssessment}}. Peer feedback themes: {{peerFeedback}}. Manager observations: {{managerNotes}}. Goals met: {{goalsMetPct}}%. Synthesize into balanced review with specific examples, development areas, growth trajectory assessment, and recommended rating.',
        gen: () => ({ employee: pk(people), role: pk(roles), department: pk(depts), period: 'H2 2025', selfAssessment: pk(['Exceeded project delivery targets', 'Led cross-functional initiative', 'Grew into technical leadership role', 'Navigated organizational change effectively']), peerFeedback: pk(['Strong collaborator, could improve documentation', 'Deep technical expertise, needs to delegate more', 'Great communicator, sometimes overcommits', 'Reliable and thorough, could take more risks']), managerNotes: pk(['Consistently high performer', 'Emerging leader potential', 'Needs support with prioritization', 'Ready for promotion discussion']), goalsMetPct: ri(60, 100) }) },
      { name: 'policy-qa', desc: 'Answer employee policy questions',
        tpl: 'Answer this HR policy question from {{employee}} ({{department}}): "{{question}}" Reference our employee handbook, applicable labor laws for {{jurisdiction}}, and current company practice. Provide a clear, specific answer with relevant policy citations. Flag if the question requires legal review or manager involvement.',
        gen: () => ({ employee: pk(people), department: pk(depts), question: pk(['Can I work remotely from another country for 3 months?', 'How does sabbatical eligibility work?', 'What is the policy on moonlighting?', 'Can I transfer to another team mid-cycle?', 'How are RSUs taxed upon vesting?', 'What accommodations are available for new parents?']), jurisdiction: pk(['California', 'New York', 'Texas', 'United Kingdom', 'Germany']) }) },
      { name: 'headcount-planner', desc: 'Plan headcount needs by department',
        tpl: 'Plan headcount for {{department}} for {{period}}. Current headcount: {{current}}. Open roles: {{open}}. Projected attrition: {{attrition}}%. Business growth target: {{growth}}%. Budget constraint: {{budget}}. Recommend optimal headcount plan, prioritized roles, hiring timeline, and contractor vs FTE mix. Flag any bottleneck roles.',
        gen: () => ({ department: pk(depts), period: 'H1 2026', current: ri(15, 80), open: ri(2, 10), attrition: ri(8, 18), growth: ri(10, 40), budget: money(500000, 3000000) }) },
      { name: 'exit-interview-analyzer', desc: 'Analyze exit interview responses for patterns',
        tpl: 'Analyze exit interview for {{employee}} ({{role}}, {{department}}, {{tenure}} years tenure). Departure reason: {{reason}}. Satisfaction scores: Manager {{mgrScore}}/5, Culture {{cultureScore}}/5, Growth {{growthScore}}/5, Comp {{compScore}}/5. Verbatim: "{{verbatim}}". Identify systemic themes, compare to department trends, and recommend retention interventions.',
        gen: () => ({ employee: pk(people), role: pk(roles), department: pk(depts), tenure: `${ri(1, 8)}.${ri(0, 9)}`, reason: pk(['Better opportunity', 'Compensation', 'Career growth', 'Work-life balance', 'Management', 'Relocation']), mgrScore: ri(2, 5), cultureScore: ri(2, 5), growthScore: ri(1, 5), compScore: ri(2, 5), verbatim: pk(['Great people, but felt stuck in my role', 'Loved the mission but comp fell behind market', 'New manager changed the team dynamic', 'Remote policy too restrictive compared to alternatives']) }) },
      { name: 'benefits-explainer', desc: 'Explain benefits packages to employees',
        tpl: 'Explain benefits package for {{employee}} ({{level}}, {{location}}, {{familyStatus}}). Open enrollment period: {{enrollmentPeriod}}. They are specifically asking about: {{question}}. Provide clear comparison of available options with cost breakdowns, coverage details, and personalized recommendation based on their situation. Include HSA/FSA implications.',
        gen: () => ({ employee: pk(people), level: pk(['IC3', 'IC4', 'IC5', 'M1', 'M2']), location: pk(['California', 'New York', 'Texas', 'Remote']), familyStatus: pk(['Single', 'Employee + Spouse', 'Employee + Children', 'Family']), enrollmentPeriod: 'Nov 1-15, 2026', question: pk(['PPO vs HDHP comparison', 'Dental coverage for orthodontics', 'Mental health benefits details', 'FSA vs HSA which is better for me', 'Life insurance options']) }) },
      { name: 'org-chart-updater', desc: 'Process organizational changes',
        tpl: 'Process org change: {{changeType}} effective {{date}}. Details: {{details}}. Affected employees: {{affected}}. Assess impact on: reporting lines, cost center allocations, system access changes, announcement communications, and any compliance implications (WARN Act, works council notification). Generate implementation checklist.',
        gen: () => ({ changeType: pk(['Team restructure', 'Manager change', 'Department merge', 'New team creation', 'Leadership transition']), date: rdate(), details: pk(['Engineering Platform team splitting into Infrastructure and Developer Experience', 'Sales reorganizing by vertical instead of region', 'Marketing and Growth teams merging under new VP', 'Creating dedicated AI/ML team from cross-functional members']), affected: `${ri(5, 40)} employees` }) },
      { name: 'compensation-benchmarker', desc: 'Benchmark compensation against market data',
        tpl: 'Benchmark compensation for {{role}} ({{level}}) in {{location}}. Current total comp: {{currentComp}} (base: {{base}}, bonus: {{bonus}}, equity: {{equity}}). Market data sources: Levels.fyi, Radford, Mercer. Assess competitiveness at 25th/50th/75th percentiles, identify gaps, and recommend adjustment if needed. Consider cost of living and role scarcity.',
        gen: () => ({ role: pk(roles), level: pk(['IC3', 'IC4', 'IC5', 'M1', 'M2']), location: pk(['SF Bay Area', 'NYC Metro', 'Austin', 'Seattle', 'Remote US']), currentComp: money(150000, 400000), base: money(120000, 250000), bonus: money(10000, 50000), equity: money(30000, 150000) }) },
    ],
  },
  marketing: {
    objective: 'revenue-growth',
    flows: [
      { name: 'campaign-brief-writer', desc: 'Write marketing campaign briefs',
        tpl: 'Write campaign brief for {{campaignType}} campaign: "{{campaignName}}". Target audience: {{audience}}. Budget: {{budget}}. Timeline: {{timeline}}. Primary KPI: {{kpi}}. Channels: {{channels}}. Include objectives, messaging framework, creative requirements, media plan outline, and measurement approach.',
        gen: () => ({ campaignType: pk(campaignTypes), campaignName: pk(['Q2 Product Launch', 'Enterprise Expansion', 'Developer Conference', 'Annual Summit', 'Partner Program Launch']), audience: pk(['Enterprise IT leaders', 'Mid-market CTOs', 'Developers', 'Marketing leaders', 'Security teams']), budget: money(25000, 200000), timeline: `${ri(4, 12)} weeks`, kpi: pk(['MQLs', 'Pipeline generated', 'Brand awareness lift', 'Event registrations', 'Demo requests']), channels: pk(['LinkedIn + Google Ads + Email', 'Content + SEO + Webinars', 'Events + PR + Social', 'Paid Search + Retargeting + ABM']) }) },
      { name: 'social-post-generator', desc: 'Generate social media content',
        tpl: 'Generate {{platform}} post about {{topic}} for our {{audience}} audience. Tone: {{tone}}. Key message: {{message}}. Include: hook, value prop, CTA. Character limit: {{charLimit}}. Suggest 3 variations with different angles. Include relevant hashtag recommendations and best posting time.',
        gen: () => ({ platform: pk(['LinkedIn', 'Twitter/X', 'Instagram', 'Facebook']), topic: pk(['Product update', 'Customer story', 'Industry trend', 'Team culture', 'Event announcement', 'Thought leadership']), audience: pk(['Enterprise buyers', 'Developers', 'Startup founders', 'General tech']), tone: pk(['Professional', 'Conversational', 'Inspirational', 'Technical']), message: pk(['New feature launch driving 3x productivity', 'Customer achieved 40% cost reduction', 'Our take on the latest industry report', 'Behind the scenes of our engineering culture']), charLimit: pk([280, 3000, 2200]) }) },
      { name: 'seo-analyzer', desc: 'Analyze and optimize content for SEO',
        tpl: 'Analyze SEO for page "{{pageTitle}}" (URL: {{url}}). Current ranking: position {{position}} for "{{keyword}}". Monthly search volume: {{volume}}. Competitors ranking above us: {{competitors}}. Analyze: title tag, meta description, heading structure, keyword density, internal linking, and content gaps. Provide specific optimization recommendations with expected impact.',
        gen: () => ({ pageTitle: pk(['What is AI Runtime?', 'Model Routing Best Practices', 'Enterprise AI Deployment Guide', 'Cost Optimization for AI Workloads']), url: `/blog/${pk(['ai-runtime', 'model-routing', 'enterprise-ai', 'cost-optimization'])}`, position: ri(4, 50), keyword: pk(['AI runtime engine', 'LLM orchestration', 'AI cost management', 'model routing platform']), volume: `${ri(500, 10000)}/mo`, competitors: `${pk(vendors)}, ${pk(vendors)}` }) },
      { name: 'email-subject-tester', desc: 'Test and optimize email subject lines',
        tpl: 'Evaluate email subject lines for {{campaignType}} campaign targeting {{audience}}. Subject A: "{{subjectA}}" | Subject B: "{{subjectB}}" | Subject C: "{{subjectC}}". Analyze: length, personalization, urgency, curiosity factor, spam trigger words. Predict open rates, recommend winner, and suggest 3 improved alternatives based on best practices.',
        gen: () => ({ campaignType: pk(campaignTypes), audience: pk(['Enterprise CTOs', 'Developers', 'IT Managers', 'Startup founders']), subjectA: pk(['Your AI costs are about to get out of control', 'See how Orion Health cut AI spend by 40%', 'You\'re invited: AI Runtime Masterclass']), subjectB: pk(['3 things every CTO should know about AI ops', 'The hidden cost of DIY AI infrastructure', '[Webinar] Scaling AI without breaking the bank']), subjectC: pk(['Quick question about your AI stack', 'We analyzed 1000 AI deployments. Here\'s what we found', 'Don\'t make this common AI routing mistake']) }) },
      { name: 'content-calendar-planner', desc: 'Plan monthly content calendar',
        tpl: 'Plan content calendar for {{month}} 2026. Theme: {{theme}}. Content mix target: {{blogCount}} blog posts, {{socialCount}} social posts, {{assetCount}} gated assets. Product launch: {{launch}} on {{launchDate}}. Industry events: {{events}}. Map content to funnel stages (awareness/consideration/decision), assign content types, suggest topics, and set publication dates.',
        gen: () => ({ month: pk(['April', 'May', 'June', 'July', 'August']), theme: pk(['AI Cost Optimization', 'Enterprise Security', 'Developer Experience', 'Digital Transformation']), blogCount: ri(4, 8), socialCount: ri(15, 30), assetCount: ri(1, 3), launch: pk(products), launchDate: rdate(), events: pk(['AWS re:Invent', 'KubeCon', 'Gartner IT Symposium', 'Web Summit', 'SaaStr Annual']) }) },
      { name: 'brand-voice-checker', desc: 'Check content for brand voice consistency',
        tpl: 'Review this {{contentType}} for brand voice consistency:\n\n"{{content}}"\n\nEvaluate against our brand guidelines: tone (confident but not arrogant), vocabulary (technical but accessible), perspective (customer-centric), and formatting standards. Score consistency 1-10. Flag specific phrases that deviate and suggest rewrites.',
        gen: () => ({ contentType: pk(contentTypes), content: pk(['Our revolutionary AI platform crushes the competition with bleeding-edge technology that will transform your entire organization overnight.', 'We help teams ship AI features faster by handling the infrastructure complexity so you can focus on building great products.', 'The enterprise-grade, mission-critical, best-in-class solution for next-generation AI orchestration and management.', 'Simple, reliable AI infrastructure. Connect your models, set your policies, ship your product.']) }) },
      { name: 'ad-copy-writer', desc: 'Write advertising copy for campaigns',
        tpl: 'Write {{adType}} ad copy for {{product}} targeting {{audience}} on {{platform}}. Campaign goal: {{goal}}. Budget: {{budget}}/month. Competitor to differentiate against: {{competitor}}. Write 3 variations with headlines, descriptions, and CTAs. Include A/B testing recommendations.',
        gen: () => ({ adType: pk(['Search', 'Display', 'Social', 'Video pre-roll']), product: pk(products), audience: pk(['Enterprise IT leaders', 'Developers', 'Startup CTOs', 'DevOps teams']), platform: pk(['Google Ads', 'LinkedIn', 'Twitter/X', 'YouTube']), goal: pk(['Demo requests', 'Free trial signups', 'Whitepaper downloads', 'Webinar registrations']), budget: money(5000, 50000), competitor: pk(vendors) }) },
      { name: 'competitor-monitor', desc: 'Monitor and summarize competitor activity',
        tpl: 'Summarize recent activity from competitor {{competitor}}: New product launch: "{{productNews}}". Pricing change: {{pricingChange}}. Key hire: {{keyHire}}. Content published: {{content}}. Assess strategic implications for our positioning, identify threats and opportunities, and recommend counter-actions with urgency rating.',
        gen: () => ({ competitor: pk(vendors), productNews: pk(['Launched AI agent framework', 'Released enterprise tier', 'Announced model marketplace', 'Shipped observability dashboard']), pricingChange: pk(['20% price cut on enterprise tier', 'New usage-based pricing', 'Free tier expanded', 'No change detected']), keyHire: pk(['Former AWS VP of AI', 'Ex-Google engineering director', 'New CRO from Datadog', 'No notable hires']), content: pk(['Published benchmark report', '3 new case studies', 'Major analyst briefing', 'Conference keynote announced']) }) },
      { name: 'press-release-drafter', desc: 'Draft press releases for announcements',
        tpl: 'Draft press release for: {{announcement}}. Key data points: {{dataPoints}}. Quotes from: {{spokesperson}} ({{title}}). Target publications: {{publications}}. Include headline, sub-headline, 3-4 body paragraphs with inverted pyramid structure, boilerplate, and media contact info. Tone: authoritative and newsworthy.',
        gen: () => ({ announcement: pk(['Series B funding of $45M', 'Partnership with major cloud provider', 'New product launch', 'Customer milestone: 500 enterprise customers', 'Industry award recognition']), dataPoints: pk(['3x YoY growth', '500+ enterprise customers', '99.99% uptime SLA', '$2B+ AI spend managed', '60% cost reduction for customers']), spokesperson: pk(people), title: pk(['CEO', 'CTO', 'VP of Product', 'Head of Engineering']), publications: 'TechCrunch, VentureBeat, The Information, Bloomberg' }) },
      { name: 'newsletter-summarizer', desc: 'Summarize content for newsletter',
        tpl: 'Curate and summarize content for our {{frequency}} newsletter "{{newsletterName}}". Target audience: {{audience}}. This edition\'s theme: {{theme}}. Available content: {{contentList}}. Select top {{count}} pieces, write engaging summaries (2-3 sentences each), craft an opening editorial paragraph, and write a compelling subject line.',
        gen: () => ({ frequency: pk(['weekly', 'bi-weekly', 'monthly']), newsletterName: pk(['The AI Dispatch', 'Runtime Digest', 'Engineering Edge', 'Platform Pulse']), audience: pk(['Technical leaders', 'Developers', 'Business stakeholders', 'All subscribers']), theme: pk(['AI Cost Management', 'Platform Updates', 'Industry Trends', 'Customer Spotlight']), contentList: '3 blog posts, 1 case study, 2 product updates, 1 industry report', count: ri(4, 6) }) },
    ],
  },
  legal: {
    objective: 'compliance',
    flows: [
      { name: 'contract-reviewer', desc: 'Review contract terms and flag risks',
        tpl: 'Review {{contractType}} contract with {{party}}. Value: {{value}}, Term: {{term}} months. Key clauses flagged: {{clauses}}. Jurisdiction: {{jurisdiction}}. Analyze: liability caps, indemnification scope, IP assignment, termination provisions, data handling obligations, and non-compete restrictions. Risk score each clause (1-10) and recommend negotiation positions.',
        gen: () => ({ contractType: pk(['SaaS subscription', 'Professional services', 'Partnership', 'Reseller', 'Data processing']), party: pk(companies), value: money(50000, 1000000), term: pk([12, 24, 36, 60]), clauses: pk(['Unlimited liability', 'Broad IP assignment', 'Auto-renewal with 90-day notice', 'Unilateral termination right']), jurisdiction: pk(['Delaware', 'California', 'New York', 'England & Wales', 'Singapore']) }) },
      { name: 'nda-summarizer', desc: 'Summarize NDA terms and flag concerns',
        tpl: 'Summarize NDA with {{party}} ({{purpose}}). Type: {{ndaType}}. Term: {{term}} years. Disclosing party: {{discloser}}. Review: definition of confidential information, exclusions, permitted disclosures, return/destruction obligations, and remedies. Flag any unusual or onerous provisions. Compare to our standard NDA template.',
        gen: () => ({ party: pk(companies), purpose: pk(['M&A due diligence', 'Partnership evaluation', 'Technology integration', 'Joint development', 'Vendor assessment']), ndaType: pk(['Mutual', 'One-way (us disclosing)', 'One-way (them disclosing)']), term: ri(1, 5), discloser: pk(['Both parties', 'Our company only', 'Counterparty only']) }) },
      { name: 'compliance-checker', desc: 'Check operations against regulatory requirements',
        tpl: 'Compliance check for {{regulation}} related to {{area}}. Current status: {{status}}. Last audit: {{lastAudit}}. Findings from last audit: {{findings}}. Assess current compliance posture, identify gaps, prioritize remediation actions, estimate effort for each, and flag any upcoming regulatory changes that may affect requirements.',
        gen: () => ({ regulation: pk(regulations), area: pk(['Data handling', 'Access controls', 'Incident response', 'Vendor management', 'Employee data', 'Financial reporting']), status: pk(['Compliant with exceptions', 'Remediation in progress', 'Audit scheduled', 'Not yet assessed']), lastAudit: rdate(), findings: pk(['3 minor findings, 0 major', '1 major finding re: access logs', 'Clean audit', '2 observations requiring follow-up']) }) },
      { name: 'risk-assessor', desc: 'Assess legal risk for business initiatives',
        tpl: 'Assess legal risk for initiative: {{initiative}}. Markets affected: {{markets}}. Estimated revenue impact: {{revenue}}. Regulatory considerations: {{regulations}}. Competitive landscape: {{competitive}}. Evaluate: regulatory risk, contractual risk, IP risk, employment law risk, and reputational risk. Score each 1-10 and provide mitigation strategies.',
        gen: () => ({ initiative: pk(['Expanding to EU market', 'Launching AI feature with customer data', 'Acquiring competitor', 'Open-sourcing core module', 'Partnering with government agency']), markets: pk(regions), revenue: money(1000000, 10000000), regulations: pk(regulations), competitive: pk(['First mover advantage', 'Crowded market', 'Regulatory moat', 'Patent landscape complex']) }) },
      { name: 'policy-updater', desc: 'Draft policy updates based on regulatory changes',
        tpl: 'Draft policy update for {{policyArea}} based on: {{trigger}}. Effective date: {{effectiveDate}}. Current policy version: {{version}}. Stakeholders: {{stakeholders}}. Draft updated policy language, identify training requirements, create implementation timeline, and assess impact on existing contracts and operations.',
        gen: () => ({ policyArea: pk(['Data retention', 'Acceptable use', 'Privacy', 'Information security', 'Anti-corruption', 'Export control']), trigger: pk(['New regulation effective Q2', 'Industry best practice update', 'Incident-driven review', 'Annual policy refresh', 'Board directive']), effectiveDate: rdate(), version: `v${ri(2, 5)}.${ri(0, 9)}`, stakeholders: 'Legal, Compliance, IT Security, HR, Engineering' }) },
      { name: 'vendor-agreement-analyzer', desc: 'Analyze vendor agreements for risk',
        tpl: 'Analyze agreement with vendor {{vendor}} for {{service}}. Annual cost: {{cost}}. SLA: {{sla}}. Data access: {{dataAccess}}. Subprocessors: {{subprocessors}}. Review: liability allocation, data processing terms, security obligations, audit rights, termination provisions, and business continuity commitments. Identify negotiation leverage points.',
        gen: () => ({ vendor: pk(vendors), service: pk(['Cloud infrastructure', 'SaaS platform', 'Professional services', 'Data processing', 'Security monitoring']), cost: money(50000, 500000), sla: pk(['99.9% uptime', '99.95% uptime', '99.99% uptime', 'Best effort']), dataAccess: pk(['PII access required', 'Anonymized data only', 'No customer data access', 'Full database access']), subprocessors: pk(['3 subprocessors disclosed', 'None', '7 subprocessors, 2 in non-EU jurisdictions', 'List available upon request']) }) },
      { name: 'ip-monitor', desc: 'Monitor intellectual property filings',
        tpl: 'IP monitoring report for {{period}}. New filings detected: {{filings}} in our space. Key filing: {{keyFiling}} by {{filer}}. Our portfolio: {{ourPatents}} active patents, {{pending}} pending. Assess: potential infringement risks, freedom-to-operate concerns, licensing opportunities, and recommended defensive actions.',
        gen: () => ({ period: `${pk(['January', 'February', 'March'])} 2026`, filings: ri(3, 15), keyFiling: pk(['AI model routing method', 'Distributed inference system', 'Cost optimization for ML workloads', 'Adaptive rate limiting for API calls']), filer: pk(vendors), ourPatents: ri(5, 20), pending: ri(2, 8) }) },
      { name: 'litigation-tracker', desc: 'Track and summarize active litigation',
        tpl: 'Litigation status update for case {{caseId}}: {{caseTitle}}. Court: {{court}}. Opposing party: {{opposing}}. Our position: {{position}}. Stage: {{stage}}. Next deadline: {{deadline}}. Estimated exposure: {{exposure}}. Summarize recent developments, assess current risk level, recommend strategy adjustments, and flag any settlement considerations.',
        gen: () => ({ caseId: `LIT-${ri(100, 999)}`, caseTitle: pk(['Patent infringement claim', 'Contract dispute', 'Employment discrimination', 'Trade secret misappropriation', 'Data breach class action']), court: pk(['N.D. Cal.', 'S.D.N.Y.', 'D. Del.', 'E.D. Tex.']), opposing: pk(companies), position: pk(['Defendant', 'Plaintiff', 'Counter-claimant']), stage: pk(['Discovery', 'Motion practice', 'Mediation', 'Trial preparation', 'Appeal']), deadline: rdate(), exposure: money(100000, 5000000) }) },
      { name: 'regulatory-update-summarizer', desc: 'Summarize regulatory updates',
        tpl: 'Summarize regulatory update: {{regulation}} — {{update}}. Effective: {{effectiveDate}}. Industries affected: {{industries}}. Our exposure: {{exposure}}. Analyze: key changes from current requirements, compliance gaps, implementation timeline needed, estimated cost of compliance, and recommended action plan with ownership assignments.',
        gen: () => ({ regulation: pk(regulations), update: pk(['New reporting requirements', 'Expanded scope of covered entities', 'Increased penalties for violations', 'New technical safeguard requirements', 'Cross-border data transfer restrictions']), effectiveDate: rdate(), industries: pk(industries), exposure: pk(['High — directly applicable', 'Medium — some provisions apply', 'Low — monitoring only', 'Under assessment']) }) },
      { name: 'gdpr-checker', desc: 'Check GDPR compliance for data processing',
        tpl: 'GDPR compliance check for {{process}}: Data subjects: {{subjects}}. Data categories: {{categories}}. Legal basis: {{legalBasis}}. Retention period: {{retention}}. Cross-border transfers: {{transfers}}. Verify: lawful basis documented, DPIA completed if required, data subject rights procedures in place, DPA with processors, and records of processing maintained. Issue compliance certificate or remediation list.',
        gen: () => ({ process: pk(['Customer onboarding', 'Marketing analytics', 'Employee monitoring', 'Vendor data sharing', 'Product telemetry', 'Support ticket processing']), subjects: pk(['EU customers', 'EU employees', 'Website visitors', 'B2B contacts']), categories: pk(['Name, email, usage data', 'Financial data, contact info', 'Behavioral analytics, IP addresses', 'HR records, performance data']), legalBasis: pk(['Consent', 'Legitimate interest', 'Contractual necessity', 'Legal obligation']), retention: pk(['12 months', '36 months', '7 years', 'Until consent withdrawn']), transfers: pk(['EU only', 'EU to US (DPF)', 'EU to US (SCCs)', 'Global — multiple jurisdictions']) }) },
    ],
  },
  support: {
    objective: 'customer-retention',
    flows: [
      { name: 'ticket-classifier', desc: 'Classify and prioritize support tickets',
        tpl: 'Classify ticket {{ticketId}} from {{customer}} ({{tier}} tier, {{industry}}). Channel: {{channel}}. Subject: "{{subject}}". Description: "{{description}}". Classify: category (Bug/Feature Request/How-to/Account/Billing), severity (P1-P4), estimated effort (S/M/L), required expertise, and optimal routing queue. Flag if SLA at risk.',
        gen: () => ({ ticketId: `TKT-${ri(10000, 99999)}`, customer: pk(companies), tier: pk(['Enterprise', 'Pro', 'Growth', 'Free']), industry: pk(industries), channel: pk(channels), subject: pk(tickets), description: pk(['This started happening after the latest update. Multiple users affected. Blocking our production workflow.', 'We need this feature for our Q2 rollout. Happy to discuss requirements in detail.', 'Tried the documentation but cannot figure out how to configure SSO with our IdP.', 'We were charged incorrectly on our last invoice. Need this resolved ASAP.']) }) },
      { name: 'response-drafter', desc: 'Draft customer support responses',
        tpl: 'Draft response for ticket {{ticketId}}. Customer: {{customer}} ({{tier}}). Issue: "{{issue}}". Sentiment: {{sentiment}}. Previous interactions: {{history}}. Draft empathetic, solution-oriented response. Include: acknowledgment, root cause (if known), resolution steps or workaround, timeline for fix, and proactive suggestions. Match tone to customer sentiment.',
        gen: () => ({ ticketId: `TKT-${ri(10000, 99999)}`, customer: pk(companies), tier: pk(['Enterprise', 'Pro', 'Growth']), issue: pk(tickets), sentiment: pk(['Frustrated', 'Neutral', 'Urgent', 'Disappointed', 'Understanding']), history: pk(['First contact', '3 previous tickets this month', 'Escalated from chat', 'Returning after 2-week silence', 'Long-term customer, usually low-touch']) }) },
      { name: 'escalation-detector', desc: 'Detect tickets that need escalation',
        tpl: 'Evaluate escalation risk for ticket {{ticketId}} from {{customer}} (ARR: {{arr}}, {{tier}}). Age: {{age}} hours. Touches: {{touches}}. Current sentiment: {{sentiment}}. Last response: {{lastResponse}}. Contract renewal in {{renewalDays}} days. Assess: escalation urgency (1-10), recommend escalation path (L2/L3/Manager/Executive), and suggest proactive intervention.',
        gen: () => ({ ticketId: `TKT-${ri(10000, 99999)}`, customer: pk(companies), arr: money(20000, 500000), tier: pk(['Enterprise', 'Pro']), age: ri(1, 168), touches: ri(1, 12), sentiment: pk(['Frustrated', 'Angry', 'Threatening churn', 'Neutral', 'Escalating']), lastResponse: pk(['Waiting on engineering', 'Workaround provided', 'No response sent yet', 'Promised update 24h ago']), renewalDays: ri(15, 365) }) },
      { name: 'knowledge-base-updater', desc: 'Update knowledge base from resolved tickets',
        tpl: 'Generate knowledge base article from resolved ticket {{ticketId}}. Issue: "{{issue}}". Root cause: {{rootCause}}. Resolution: {{resolution}}. Affected product: {{product}}. Create: searchable title, problem description, step-by-step solution, troubleshooting decision tree, related articles, and applicable product versions.',
        gen: () => ({ ticketId: `TKT-${ri(10000, 99999)}`, issue: pk(tickets), rootCause: pk(['Configuration mismatch after upgrade', 'Race condition in auth flow', 'Cache invalidation timing', 'Third-party API rate limit', 'Permission inheritance bug']), resolution: pk(['Updated config and restarted service', 'Applied hotfix v2.3.1', 'Cleared cache and adjusted TTL', 'Implemented retry with backoff', 'Corrected permission propagation logic']), product: pk(products) }) },
      { name: 'sentiment-analyzer', desc: 'Analyze customer sentiment across interactions',
        tpl: 'Analyze sentiment trajectory for {{customer}} ({{tier}}, ARR: {{arr}}). Last {{count}} interactions: {{interactions}}. CSAT trend: {{csatTrend}}. NPS last survey: {{nps}}. Identify: overall sentiment direction, key drivers (positive and negative), risk of churn, and recommended engagement strategy with specific actions.',
        gen: () => ({ customer: pk(companies), tier: pk(['Enterprise', 'Pro', 'Growth']), arr: money(20000, 300000), count: ri(5, 20), interactions: pk(['Mix of positive and frustrated', 'Increasingly negative over 3 months', 'Stable and positive', 'Sharp negative turn after outage']), csatTrend: pk(['Declining (4.2 → 3.1)', 'Stable (4.5)', 'Improving (3.0 → 4.1)', 'Volatile']), nps: ri(-20, 80) }) },
      { name: 'churn-risk-detector', desc: 'Detect early churn risk signals',
        tpl: 'Assess churn risk for {{customer}} ({{tier}}, ARR: {{arr}}, renewal: {{renewalDate}}). Usage: {{usage}} (was {{previousUsage}} last quarter). Active users: {{activeUsers}}/{{licensedUsers}}. Support tickets: {{tickets}} ({{trend}}). Executive sponsor: {{sponsor}}. Score churn risk (1-100), identify top 3 risk signals, and recommend immediate interventions.',
        gen: () => ({ customer: pk(companies), tier: pk(['Enterprise', 'Pro']), arr: money(30000, 500000), renewalDate: rdate(), usage: `${ri(20, 90)}%`, previousUsage: `${ri(40, 100)}%`, activeUsers: ri(5, 100), licensedUsers: ri(20, 200), tickets: ri(0, 20), trend: pk(['increasing', 'decreasing', 'stable', 'spike this month']), sponsor: pk([...people.slice(0, 3), 'Left company', 'Unresponsive']) }) },
      { name: 'refund-processor', desc: 'Process and evaluate refund requests',
        tpl: 'Evaluate refund request from {{customer}} ({{tier}}, customer since {{since}}). Amount: {{amount}}. Reason: "{{reason}}". Contract terms: {{terms}}. Previous refunds: {{previousRefunds}}. Account health: {{health}}/100. Recommend: full refund, partial refund, credit, or deny. Include justification, retention alternative, and escalation path if customer objects.',
        gen: () => ({ customer: pk(companies), tier: pk(['Enterprise', 'Pro', 'Growth']), since: `${ri(2020, 2025)}`, amount: money(500, 50000), reason: pk(['Service outage exceeded SLA', 'Feature promised in sales process not delivered', 'Billing error — charged for cancelled add-on', 'Dissatisfied with support response time', 'Switching to competitor']), terms: pk(['30-day money-back', 'Pro-rata refund policy', 'No refund clause', 'SLA credit only']), previousRefunds: pk(['None', '1 credit last year', '2 refunds in 12 months']), health: ri(20, 90) }) },
      { name: 'sla-monitor', desc: 'Monitor SLA compliance across accounts',
        tpl: 'SLA compliance report for {{period}}. Accounts monitored: {{accountCount}}. Breaches: {{breaches}}. Near-misses (within 10%): {{nearMisses}}. Worst performing metric: {{worstMetric}}. Top breached account: {{worstAccount}} ({{breachCount}} breaches). Analyze trends, root causes of breaches, impact on customer satisfaction, and recommend operational improvements.',
        gen: () => ({ period: pk(['Last 7 days', 'Last 30 days', 'Q1 2026']), accountCount: ri(50, 200), breaches: ri(0, 12), nearMisses: ri(2, 20), worstMetric: pk(['First response time', 'Resolution time', 'Uptime', 'P1 acknowledgment']), worstAccount: pk(companies), breachCount: ri(1, 5) }) },
      { name: 'feedback-summarizer', desc: 'Summarize customer feedback themes',
        tpl: 'Summarize customer feedback for {{period}}. Sources: {{sources}}. Total responses: {{count}}. Average rating: {{avgRating}}/5. Top positive themes: {{positiveThemes}}. Top negative themes: {{negativeThemes}}. Synthesize into executive summary with: key trends, product implications, competitive insights, and recommended actions prioritized by impact.',
        gen: () => ({ period: pk(['Last 30 days', 'Q1 2026', 'Post-release survey']), sources: 'CSAT surveys, NPS, App Store reviews, G2, Support tickets', count: ri(50, 500), avgRating: `${(ri(30, 48) / 10).toFixed(1)}`, positiveThemes: pk(['Easy to use', 'Great support team', 'Powerful API', 'Fast performance']), negativeThemes: pk(['Documentation gaps', 'Pricing too high', 'Missing integrations', 'Slow feature delivery']) }) },
      { name: 'faq-generator', desc: 'Generate FAQ entries from common issues',
        tpl: 'Generate FAQ entries from the top {{count}} support topics this {{period}}. Top topics: {{topics}}. For each: write clear question, concise answer, link to relevant docs, and tag with product area. Optimize for search and chatbot consumption. Include "Was this helpful?" prompt suggestions.',
        gen: () => ({ count: ri(5, 10), period: pk(['week', 'month', 'quarter']), topics: `${pk(tickets)}, ${pk(tickets)}, ${pk(tickets)}` }) },
    ],
  },
  engineering: {
    objective: 'product-quality',
    flows: [
      { name: 'pr-reviewer', desc: 'Review pull requests for quality and standards',
        tpl: 'Review PR #{{prNumber}} in {{repo}}: "{{title}}" by {{author}}. Changes: {{filesChanged}} files, +{{additions}}/-{{deletions}}. Description: "{{description}}". Review for: code quality, test coverage, security implications, performance impact, API compatibility, and documentation needs. Provide specific line-level feedback and approve/request-changes decision.',
        gen: () => ({ prNumber: ri(100, 9999), repo: pk(repos), title: pk(['Add retry logic to API gateway', 'Refactor auth middleware', 'Fix race condition in queue processor', 'Add pagination to list endpoints', 'Migrate to new SDK version']), author: pk(people), filesChanged: ri(2, 25), additions: ri(10, 500), deletions: ri(5, 300), description: pk(['Implements exponential backoff with jitter for transient failures', 'Extracts shared auth logic into middleware chain', 'Fixes concurrent access bug reported in TKT-45321', 'Adds cursor-based pagination per API standards doc']) }) },
      { name: 'incident-summarizer', desc: 'Summarize production incidents',
        tpl: 'Summarize incident {{incidentId}}: {{title}}. Severity: {{severity}}. Duration: {{duration}} minutes. Services affected: {{services}}. Impact: {{impact}}. Timeline: Detection at {{detected}}, Mitigated at {{mitigated}}. Root cause: {{rootCause}}. Generate: executive summary, detailed timeline, root cause analysis, action items with owners, and customer communication draft.',
        gen: () => ({ incidentId: `INC-${ri(100, 999)}`, title: pk(['API latency spike', 'Database failover', 'Authentication service degraded', 'Data pipeline backlog', 'CDN cache invalidation failure']), severity: pk(severities), duration: ri(5, 180), services: pk(repos), impact: pk(['5% of API requests affected', '200 customers experienced errors', 'Batch processing delayed 2 hours', 'Dashboard loading times 10x normal']), detected: pk(['Automated alert', 'Customer report', 'Internal monitoring', 'Canary deployment']), mitigated: pk(['Rolled back deployment', 'Scaled up instances', 'Failed over to secondary', 'Flushed cache manually']), rootCause: pk(['Memory leak in new release', 'Database connection pool exhaustion', 'Third-party API timeout cascade', 'Configuration drift in production']) }) },
      { name: 'tech-debt-tracker', desc: 'Track and prioritize technical debt',
        tpl: 'Assess tech debt item: {{item}} in {{repo}}. Age: {{age}} months. Affected area: {{area}}. Current impact: {{impact}}. Estimated remediation: {{effort}}. Dependencies: {{deps}}. Evaluate: severity (1-10), blast radius, compounding risk, alignment with roadmap, and opportunity cost of deferral. Recommend priority and remediation approach.',
        gen: () => ({ item: pk(['Legacy auth system migration', 'Test suite parallelization', 'Database schema normalization', 'API versioning overhaul', 'Monolith service extraction', 'Dependency upgrade backlog']), repo: pk(repos), age: ri(3, 24), area: pk(['Performance', 'Reliability', 'Developer experience', 'Security', 'Scalability']), impact: pk(['Slows CI by 15 minutes', 'Causes intermittent failures', 'Blocks feature development', 'Creates security vulnerability window']), effort: pk(['2 sprints', '1 quarter', '3 weeks', '6 months']), deps: pk(['Requires API freeze', 'No dependencies', 'Blocked by infra upgrade', 'Needs cross-team coordination']) }) },
      { name: 'deployment-checker', desc: 'Pre-deployment safety checks',
        tpl: 'Pre-deployment check for {{repo}} release {{version}} to {{environment}}. Changes since last deploy: {{changeCount}} commits by {{authorCount}} authors. Key changes: {{keyChanges}}. Test results: {{testResults}}. DB migrations: {{migrations}}. Feature flags: {{flags}}. Verify: all checks pass, rollback plan documented, monitoring alerts configured, and gradual rollout strategy defined.',
        gen: () => ({ repo: pk(repos), version: `v${ri(2, 5)}.${ri(0, 20)}.${ri(0, 50)}`, environment: pk(['production', 'staging', 'canary']), changeCount: ri(3, 30), authorCount: ri(1, 8), keyChanges: pk(['New payment processing flow', 'Auth middleware refactor', 'Search index migration', 'Rate limiter updates']), testResults: pk(['2847 passed, 0 failed', '2841 passed, 6 skipped', '2830 passed, 3 failed (known flaky)']), migrations: pk(['None', '1 additive migration', '2 migrations (1 irreversible)', 'Schema change requiring backfill']), flags: pk(['2 new flags enabled', 'No new flags', '1 flag removing old code path']) }) },
      { name: 'api-doc-generator', desc: 'Generate API documentation from code',
        tpl: 'Generate documentation for {{endpoint}} endpoint in {{repo}}. Method: {{method}}. Auth: {{auth}}. Rate limit: {{rateLimit}}. Request schema: {{requestSchema}}. Response codes: {{responseCodes}}. Generate: OpenAPI-compatible description, parameter documentation, example requests/responses, error handling guide, and migration notes from previous version.',
        gen: () => ({ endpoint: pk(['/v1/flows', '/v1/executions', '/v1/triggers', '/v1/health', '/v1/users', '/v1/webhooks']), repo: pk(repos), method: pk(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']), auth: pk(['Bearer token', 'API key', 'OAuth 2.0', 'mTLS']), rateLimit: `${ri(10, 1000)} req/min`, requestSchema: pk(['JSON body with required fields', 'Query parameters only', 'Multipart form data', 'No request body']), responseCodes: '200, 400, 401, 403, 404, 429, 500' }) },
      { name: 'bug-triage', desc: 'Triage and prioritize bug reports',
        tpl: 'Triage bug {{bugId}}: "{{title}}" reported by {{reporter}}. Reproduction: {{reproduction}}. Environment: {{environment}}. Frequency: {{frequency}}. User impact: {{impact}}. Assign: severity (P1-P4), component owner, estimated fix complexity (S/M/L/XL), and recommend SLA target. Flag if related to recent changes.',
        gen: () => ({ bugId: `BUG-${ri(1000, 9999)}`, title: pk(['Intermittent 500 errors on dashboard load', 'CSV export truncates at 10k rows', 'OAuth callback fails with special characters', 'Memory leak in long-running WebSocket connections', 'Timezone display incorrect for APAC users']), reporter: pk([...people.slice(0, 3), 'Customer: ' + pk(companies)]), reproduction: pk(['Consistent — steps documented', 'Intermittent — ~20% of attempts', 'Rare — only reported once', 'Environment-specific — production only']), environment: pk(['Production', 'Staging', 'Customer sandbox', 'All environments']), frequency: pk(['Every request', 'Daily occurrence', 'Weekly', 'Rare but critical']), impact: pk(['All users blocked', '10% of users affected', 'Cosmetic — no data loss', 'Edge case — workaround available']) }) },
      { name: 'security-scanner', desc: 'Scan and report security findings',
        tpl: 'Security scan results for {{repo}} (scan date: {{date}}). Total findings: {{total}} (Critical: {{critical}}, High: {{high}}, Medium: {{medium}}, Low: {{low}}). Top finding: {{topFinding}}. Dependencies with known CVEs: {{cves}}. Assess: overall security posture, prioritize remediation, estimate effort per finding, and identify quick wins.',
        gen: () => ({ repo: pk(repos), date: rdate(), total: ri(5, 50), critical: ri(0, 3), high: ri(0, 8), medium: ri(2, 20), low: ri(3, 25), topFinding: pk(['SQL injection in search parameter', 'Hardcoded API key in config', 'Outdated TLS configuration', 'Missing rate limiting on auth endpoint', 'SSRF vulnerability in webhook handler']), cves: `${ri(0, 5)} packages with known vulnerabilities` }) },
      { name: 'code-explainer', desc: 'Explain complex code sections',
        tpl: 'Explain the {{component}} component in {{repo}} ({{fileCount}} files, {{loc}} LOC). Architecture: {{architecture}}. Key interfaces: {{interfaces}}. Known complexity: {{complexity}}. Produce: high-level overview, data flow diagram (text), key design decisions and trade-offs, common modification patterns, and gotchas for new contributors.',
        gen: () => ({ component: pk(['Auth middleware', 'Event pipeline', 'Rate limiter', 'Cache layer', 'Query builder', 'State machine']), repo: pk(repos), fileCount: ri(3, 15), loc: `${ri(500, 5000)}`, architecture: pk(['Event-driven', 'Request-response pipeline', 'Actor model', 'Plugin architecture', 'CQRS']), interfaces: pk(['3 public interfaces, 5 internal', '1 main interface with 12 methods', 'Event emitter + handler pattern']), complexity: pk(['Circular dependency risk', 'Performance-sensitive hot path', 'Complex state transitions', 'Multi-tenant isolation concerns']) }) },
      { name: 'architecture-reviewer', desc: 'Review architecture decision records',
        tpl: 'Review ADR for: {{decision}}. Context: {{context}}. Options considered: {{options}}. Recommended: {{recommended}}. Trade-offs: {{tradeoffs}}. Evaluate: alignment with system principles, scalability implications, operational complexity, migration path, and reversibility. Provide recommendation with confidence level.',
        gen: () => ({ decision: pk(['Migrate from REST to gRPC for internal services', 'Adopt event sourcing for audit trail', 'Move to multi-region deployment', 'Replace custom auth with managed IdP', 'Introduce service mesh']), context: pk(['Growing latency between services', 'Compliance requires immutable audit log', 'Customer demand for data residency', 'Auth system maintenance overhead increasing', 'Network policy management at scale']), options: pk(['gRPC vs GraphQL vs keep REST', 'Event sourcing vs CDC vs audit table', 'Multi-region active-active vs active-passive', 'Auth0 vs Okta vs custom', 'Istio vs Linkerd vs custom proxy']), recommended: pk(['Option A — best performance characteristics', 'Option B — balanced approach', 'Option C — lowest risk']), tradeoffs: pk(['Higher complexity, better performance', 'More operational overhead, better auditability', 'Higher cost, better reliability', 'Vendor lock-in, lower maintenance']) }) },
      { name: 'dependency-auditor', desc: 'Audit project dependencies',
        tpl: 'Audit dependencies for {{repo}}. Total: {{total}} packages ({{direct}} direct, {{transitive}} transitive). Outdated: {{outdated}}. Deprecated: {{deprecated}}. License concerns: {{licenses}}. Largest: {{largest}}. Assess: supply chain risk, update urgency, breaking change risk for major updates, and bundle size impact. Recommend update strategy.',
        gen: () => ({ repo: pk(repos), total: ri(100, 500), direct: ri(20, 80), transitive: ri(80, 420), outdated: ri(5, 30), deprecated: ri(0, 5), licenses: pk(['2 packages with GPL-3.0', 'All MIT/Apache — no concerns', '1 package with BUSL license', '3 packages with unclear licensing']), largest: pk(['lodash (72KB)', 'moment (289KB)', 'aws-sdk (45MB)', 'tensorflow (180MB)']) }) },
    ],
  },
  operations: {
    objective: 'operational-visibility',
    flows: [
      { name: 'meeting-notes', desc: 'Summarize meeting recordings and notes',
        tpl: 'Summarize meeting: "{{title}}" ({{duration}} min, {{attendeeCount}} attendees). Key participants: {{participants}}. Raw notes: "{{notes}}". Extract: decisions made, action items with owners and deadlines, open questions, parking lot items, and next meeting agenda suggestions. Format for async distribution.',
        gen: () => ({ title: pk(['Q2 Planning Review', 'Architecture Decision Meeting', 'Customer Escalation Sync', 'Sprint Retrospective', 'All-Hands Prep', 'Board Deck Review']), duration: ri(30, 90), attendeeCount: ri(3, 15), participants: `${pk(people)}, ${pk(people)}, ${pk(people)}`, notes: pk(['Discussed Q2 priorities. Agreed to focus on enterprise features. David to draft roadmap by Friday. Budget approved for 2 new hires. Concern about timeline for security compliance — need follow-up.', 'Reviewed incident from last week. Root cause was config drift. Agreed on new deployment checklist. Sarah to update runbook. Need to schedule chaos engineering session.', 'Customer threatening to churn over feature gap. Committed to shipping workaround by end of month. Escalated pricing discussion to VP.']) }) },
      { name: 'project-status-rollup', desc: 'Roll up project status across teams',
        tpl: 'Generate status rollup for {{project}} ({{teamCount}} teams, {{duration}}). Team statuses: {{statuses}}. Milestones: {{milestones}}. Risks: {{risks}}. Budget: {{budgetStatus}}. Synthesize into executive dashboard with: overall health (green/yellow/red), key achievements, blockers, risk mitigation status, and forecast to completion.',
        gen: () => ({ project: pk(['Platform Migration', 'Q2 Product Launch', 'Security Compliance', 'Infrastructure Modernization', 'Customer Portal Redesign']), teamCount: ri(3, 8), duration: pk(['Sprint 4 of 8', 'Month 3 of 6', 'Week 8 of 12', 'Phase 2 of 3']), statuses: pk(['3 on track, 1 at risk, 1 behind', 'All on track', '2 on track, 2 at risk', '4 on track, 1 blocked']), milestones: pk(['API freeze next week', 'Beta launch in 2 weeks', 'Security audit scheduled', 'Load testing complete']), risks: pk(['Key engineer on leave', 'Dependency on vendor deliverable', 'Scope creep in UI workstream', 'Performance regression in staging']), budgetStatus: pk(['On budget', '10% over — approved', '15% under — reallocating', 'At risk — needs review']) }) },
      { name: 'vendor-onboarding', desc: 'Manage vendor onboarding process',
        tpl: 'Onboard vendor {{vendor}} for {{service}}. Annual value: {{value}}. Compliance requirements: {{compliance}}. Integration type: {{integration}}. Data access: {{dataAccess}}. Generate onboarding checklist: legal review, security assessment, compliance verification, technical integration plan, communication plan, and go-live criteria.',
        gen: () => ({ vendor: pk(vendors), service: pk(['Cloud infrastructure', 'SaaS tool', 'Consulting services', 'Data provider', 'Security monitoring']), value: money(25000, 500000), compliance: pk(regulations), integration: pk(['API integration', 'SSO federation', 'Data feed', 'Manual process', 'SDK embedding']), dataAccess: pk(['PII access required', 'Anonymized data only', 'No data access', 'Read-only access to metrics']) }) },
      { name: 'resource-allocator', desc: 'Optimize resource allocation across projects',
        tpl: 'Optimize resource allocation for {{period}}. Available: {{available}} FTEs. Projects requesting: {{requesting}} FTEs. Priority projects: {{priorities}}. Constraints: {{constraints}}. Current allocation: {{current}}. Recommend allocation that maximizes strategic value, identify trade-offs, flag under-resourced critical projects, and suggest contractor backfill where appropriate.',
        gen: () => ({ period: pk(['Q2 2026', 'Sprint 5-6', 'Next month', 'H2 2026']), available: ri(20, 60), requesting: ri(30, 80), priorities: pk(['Security compliance (P0)', 'Product launch (P0)', 'Tech debt (P1)', 'New feature (P1)']), constraints: pk(['2 engineers on leave', 'Hiring freeze until April', 'No contractor budget', 'Must maintain on-call rotation']), current: pk(['60% product, 20% infra, 20% debt', '80% features, 10% bugs, 10% debt', 'Evenly split across 4 projects']) }) },
      { name: 'supply-chain-monitor', desc: 'Monitor software supply chain health',
        tpl: 'Supply chain health report for {{period}}. Vendors monitored: {{vendorCount}}. SLA breaches: {{breaches}}. Cost anomalies: {{anomalies}}. Upcoming renewals: {{renewals}}. Security advisories: {{advisories}}. Assess: overall supply chain risk, vendor concentration, cost trends, and recommend diversification or consolidation actions.',
        gen: () => ({ period: pk(['Last 30 days', 'Q1 2026', 'This week']), vendorCount: ri(15, 50), breaches: ri(0, 5), anomalies: pk(['AWS bill 20% above forecast', 'No anomalies', 'Datadog usage spike', 'Unexpected Twilio charges']), renewals: `${ri(2, 6)} in next 90 days`, advisories: pk(['1 critical (log4j follow-up)', 'None active', '2 medium severity', '3 low priority']) }) },
      { name: 'risk-register-update', desc: 'Update organizational risk register',
        tpl: 'Update risk register with new assessment. Risk: "{{risk}}". Category: {{category}}. Likelihood: {{likelihood}}/5. Impact: {{impact}}/5. Current controls: {{controls}}. Trend: {{trend}}. Evaluate: residual risk score, control effectiveness, trigger indicators, escalation criteria, and recommended additional mitigations with cost estimates.',
        gen: () => ({ risk: pk(['Key person dependency on infrastructure team', 'Competitor pricing pressure', 'Regulatory compliance gap', 'Third-party vendor failure', 'Data breach exposure', 'Market downturn impact on renewals']), category: pk(['Operational', 'Strategic', 'Financial', 'Compliance', 'Technical', 'Reputational']), likelihood: ri(1, 5), impact: ri(1, 5), controls: pk(['Quarterly review', 'Automated monitoring', 'Insurance policy', 'Redundant systems', 'Cross-training program']), trend: pk(['Increasing', 'Stable', 'Decreasing', 'New risk']) }) },
      { name: 'kpi-tracker', desc: 'Track and report on KPIs',
        tpl: 'KPI report for {{period}}. Revenue: {{revenue}} (target: {{revenueTarget}}). Churn: {{churn}}% (target: <{{churnTarget}}%). NPS: {{nps}} (target: >{{npsTarget}}). Engineering velocity: {{velocity}} points/sprint. Customer acquisition cost: {{cac}}. Analyze: performance vs targets, trend direction, leading indicators, and recommend interventions for any KPIs trending below target.',
        gen: () => ({ period: pk(['February 2026', 'Q1 2026', 'Last 30 days']), revenue: money(2000000, 8000000), revenueTarget: money(2500000, 9000000), churn: `${(ri(10, 50) / 10).toFixed(1)}`, churnTarget: `${(ri(20, 40) / 10).toFixed(1)}`, nps: ri(20, 75), npsTarget: ri(40, 60), velocity: ri(30, 80), cac: money(5000, 25000) }) },
      { name: 'capacity-planner', desc: 'Plan infrastructure and team capacity',
        tpl: 'Capacity plan for {{service}} ({{period}}). Current: {{currentCapacity}}. Peak usage: {{peakUsage}}. Growth projection: {{growth}}%/month. Upcoming events: {{events}}. Budget: {{budget}}. Recommend: scaling strategy (vertical/horizontal), timeline, cost projection, and failover capacity. Flag any capacity cliff risks.',
        gen: () => ({ service: pk(repos), period: pk(['Q2 2026', 'Next 6 months', 'Black Friday prep']), currentCapacity: pk(['80% CPU, 60% memory', '45% of connection pool', '70% of storage tier', '90% of API rate limit']), peakUsage: pk(['95% during business hours', '85% Mondays', '99% during batch processing']), growth: ri(5, 25), events: pk(['Product launch March 15', 'Customer migration April 1', 'Marketing campaign Q2', 'Conference demo May 20']), budget: money(10000, 100000) }) },
      { name: 'process-improver', desc: 'Identify and recommend process improvements',
        tpl: 'Analyze process: {{process}}. Current cycle time: {{cycleTime}}. Steps: {{steps}}. Bottleneck: {{bottleneck}}. Error rate: {{errorRate}}%. Stakeholders: {{stakeholders}}. Identify improvement opportunities, estimate impact of each, recommend implementation priority, and draft change management plan.',
        gen: () => ({ process: pk(['Customer onboarding', 'Incident response', 'Release management', 'Vendor procurement', 'Expense approval', 'Hiring pipeline']), cycleTime: pk(['5 business days', '45 minutes', '2 weeks', '3 hours', '10 business days']), steps: ri(5, 15), bottleneck: pk(['Manual approval step', 'Waiting for legal review', 'Environment provisioning', 'Cross-team handoff', 'Data entry duplication']), errorRate: ri(2, 25), stakeholders: `${pk(depts)}, ${pk(depts)}, ${pk(depts)}` }) },
      { name: 'sop-generator', desc: 'Generate standard operating procedures',
        tpl: 'Generate SOP for {{procedure}}. Audience: {{audience}}. Criticality: {{criticality}}. Current documentation: {{currentDocs}}. Compliance requirements: {{compliance}}. Create: purpose and scope, roles and responsibilities, step-by-step instructions, decision trees for edge cases, quality checks, and version control metadata.',
        gen: () => ({ procedure: pk(['Production deployment', 'Security incident response', 'Customer data deletion request', 'New employee system access provisioning', 'Vendor security assessment', 'Quarterly access review']), audience: pk(['Engineering team', 'All employees', 'IT Operations', 'Legal and Compliance', 'Customer Success']), criticality: pk(['Business critical', 'High', 'Medium', 'Standard']), currentDocs: pk(['Outdated wiki page', 'Tribal knowledge only', 'Partial runbook exists', 'No documentation']), compliance: pk(['SOC 2 required', 'GDPR mandated', 'Internal policy', 'No specific requirement', pk(regulations)]) }) },
    ],
  },
};

// ── Agent Flow Definitions (10 flows) ────────────────────────────────────────

const agentFlowDefs: AFlowDef[] = [
  {
    name: 'research-analyst-agent',
    desc: 'Deep market and competitor research with multi-step analysis and executive summary',
    objective: 'market-intelligence',
    maxIterations: 6,
    systemPrompt: `You are a senior market research analyst conducting deep competitive intelligence research. Your process:

1. LANDSCAPE ANALYSIS: Map the competitive landscape — identify all direct and indirect competitors, their positioning, recent funding, team size, and go-to-market strategy.
2. PRODUCT COMPARISON: For each competitor, analyze their product offering — feature set, pricing tiers, integration ecosystem, and technical architecture. Note any recent launches or pivots.
3. CUSTOMER INTELLIGENCE: Analyze customer reviews (G2, Capterra, Reddit, HackerNews), win/loss data, and switching patterns. Identify what customers love and hate about each option.
4. TREND SYNTHESIS: Identify macro trends affecting the competitive landscape — regulatory changes, technology shifts, market consolidation, talent movement.
5. STRATEGIC RECOMMENDATIONS: Synthesize findings into actionable recommendations — positioning adjustments, feature priorities, pricing strategy, and partnership opportunities.

Always cite specific data points. Quantify market sizes and growth rates. Include confidence levels for each finding. Format output as an executive briefing with an executive summary, detailed sections, and appendix of sources.`,
    gen: () => ({
      industry: pk(industries),
      competitors: `${pk(vendors)}, ${pk(vendors)}, ${pk(vendors)}`,
      focusArea: pk(['Pricing strategy', 'Product differentiation', 'Market entry', 'Customer acquisition', 'Technology trends']),
      timeframe: pk(['Q2 2026', 'Next 12 months', 'FY2026', '90-day outlook']),
      context: `Our company is a ${pk(['Series B', 'Series C', 'growth-stage', 'public'])} ${pk(industries).toLowerCase()} technology company with ${money(5000000, 50000000)} ARR. We are seeing increased competition from ${pk(vendors)} and need to understand how to maintain our market position. Key customers include ${pk(companies)} and ${pk(companies)}. Our primary differentiator has been ${pk(['technical depth', 'ease of use', 'enterprise security', 'integration breadth', 'pricing transparency'])} but competitors are closing the gap.`,
    }),
  },
  {
    name: 'customer-success-agent',
    desc: 'Full customer health analysis with usage patterns and intervention recommendations',
    objective: 'customer-retention',
    maxIterations: 5,
    systemPrompt: `You are a senior customer success manager conducting a comprehensive customer health analysis. Your process:

1. USAGE ANALYSIS: Analyze product adoption metrics — DAU/MAU ratio, feature adoption depth, session frequency, and usage trends over the last 90 days. Identify power users and dormant users.
2. SUPPORT HISTORY: Review all support interactions — ticket volume trends, severity distribution, resolution satisfaction, and recurring themes. Note any unresolved escalations.
3. RELATIONSHIP HEALTH: Assess stakeholder engagement — executive sponsor activity, champion status, decision-maker involvement, and breadth of organizational adoption.
4. RENEWAL RISK ASSESSMENT: Score renewal probability based on usage, satisfaction, competitive alternatives, contract terms, and business fit. Model scenarios for expansion vs contraction.
5. ACTION PLAN: Generate a prioritized intervention plan — immediate actions (next 7 days), short-term (30 days), and strategic (90 days). Include specific talking points for each stakeholder.

Be specific with numbers and percentages. Flag any leading indicators of churn. Recommend the minimum intervention needed — avoid over-engineering the engagement plan.`,
    gen: () => ({
      customer: pk(companies),
      tier: pk(['Enterprise', 'Pro', 'Growth']),
      arr: money(30000, 500000),
      contractEnd: rdate(),
      usage: `${ri(20, 95)}% of licensed capacity, ${ri(5, 200)} active users, ${pk(['trending up', 'trending down', 'stable', 'volatile'])}`,
      recentTickets: `${ri(0, 15)} tickets in last 30 days (${ri(0, 3)} P1/P2), themes: ${pk(['Performance complaints', 'Integration questions', 'Feature requests', 'Billing inquiries', 'Onboarding support'])}`,
      stakeholders: `Champion: ${pk(people)} (${pk(['active', 'disengaged', 'left company'])}), Exec sponsor: ${pk(people)} (${pk(['engaged', 'delegated', 'unknown'])})`,
    }),
  },
  {
    name: 'market-intelligence-agent',
    desc: 'Competitor pricing, feature gaps, and positioning analysis',
    objective: 'market-intelligence',
    maxIterations: 7,
    systemPrompt: `You are a market intelligence analyst specializing in competitive pricing and product positioning. Your process:

1. PRICING ARCHITECTURE: Deconstruct each competitor's pricing model — tiers, usage metrics, overage charges, enterprise negotiation ranges, and public vs private pricing. Note any recent changes.
2. FEATURE MATRIX: Build a detailed feature comparison matrix across all competitors. Identify our unique features, their unique features, and table-stakes features. Note feature quality differences, not just presence.
3. POSITIONING MAP: Map each competitor on key dimensions — enterprise vs SMB focus, horizontal vs vertical, self-serve vs sales-led, open-source vs proprietary.
4. GAP ANALYSIS: Identify critical feature and positioning gaps. Quantify the revenue impact of each gap using deal loss data, feature request volume, and competitive win/loss patterns.
5. RECOMMENDATIONS: Recommend pricing adjustments, feature investments, and positioning changes. Prioritize by revenue impact and implementation effort. Include timeline estimates.

Use specific data points. Include confidence intervals. Distinguish between verified information and estimates. Format as a structured intelligence brief.`,
    gen: () => ({
      competitors: `${pk(vendors)}, ${pk(vendors)}, ${pk(vendors)}, ${pk(vendors)}`,
      segment: pk(['Enterprise', 'Mid-market', 'SMB', 'Developer', 'All segments']),
      focusProduct: pk(products),
      recentEvents: `${pk(vendors)} ${pk(['raised $50M Series C', 'launched free tier', 'acquired competitor', 'cut prices 30%', 'announced enterprise features'])}. ${pk(vendors)} ${pk(['released open-source alternative', 'expanded to EU market', 'partnered with AWS', 'reported 3x growth'])}`,
    }),
  },
  {
    name: 'financial-due-diligence-agent',
    desc: 'Multi-step financial analysis with revenue trends and risk assessment',
    objective: 'cost-optimization',
    maxIterations: 6,
    systemPrompt: `You are a senior financial analyst conducting due diligence. Your process:

1. REVENUE ANALYSIS: Analyze revenue trends — MRR/ARR trajectory, growth rate, seasonal patterns, customer concentration, and cohort retention curves. Identify inflection points.
2. UNIT ECONOMICS: Calculate and assess key unit economics — CAC, LTV, LTV:CAC ratio, payback period, gross margin by segment, and net revenue retention. Compare to industry benchmarks.
3. BURN RATE & RUNWAY: Analyze cash position, monthly burn rate, burn rate trend, and projected runway under current and reduced-spend scenarios. Model path to profitability.
4. RISK IDENTIFICATION: Identify financial red flags — customer concentration, revenue quality (one-time vs recurring), deferred revenue obligations, off-balance-sheet commitments, and key person dependencies.
5. VALUATION CONTEXT: Frame the financial profile within industry comparables — revenue multiples, growth-adjusted metrics, and recent transaction benchmarks.

Use precise numbers. Show calculations. Flag assumptions explicitly. Rate confidence in each metric (high/medium/low). Format as a due diligence memo.`,
    gen: () => ({
      company: pk(companies),
      revenue: money(5000000, 50000000),
      growth: `${ri(20, 150)}% YoY`,
      margins: `Gross: ${ri(60, 85)}%, Net: ${ri(-30, 20)}%`,
      headcount: ri(50, 500),
      lastFunding: `${pk(['Series A', 'Series B', 'Series C', 'Pre-IPO'])} — ${money(10000000, 100000000)} at ${money(50000000, 500000000)} valuation`,
      context: `Evaluating for ${pk(['acquisition target', 'investment opportunity', 'partnership assessment', 'competitive benchmark', 'board reporting'])}`,
    }),
  },
  {
    name: 'security-audit-agent',
    desc: 'Systematic security review with threat modeling and remediation priorities',
    objective: 'product-quality',
    maxIterations: 5,
    systemPrompt: `You are a senior security engineer conducting a comprehensive security audit. Your process:

1. THREAT MODEL: Identify threat actors (external attackers, malicious insiders, supply chain), attack surfaces (APIs, authentication, data stores, third-party integrations), and prioritized threat scenarios using STRIDE methodology.
2. VULNERABILITY ASSESSMENT: Review known vulnerabilities — dependency CVEs, configuration weaknesses, code-level findings from SAST/DAST, and infrastructure misconfigurations. Classify by CVSS score.
3. CONTROL EVALUATION: Assess existing security controls — authentication mechanisms, authorization model, encryption (at rest and in transit), logging and monitoring, and incident response procedures. Identify gaps.
4. COMPLIANCE MAPPING: Map findings to relevant compliance frameworks — SOC 2, ISO 27001, GDPR, HIPAA (if applicable). Identify compliance gaps that require remediation.
5. REMEDIATION ROADMAP: Prioritize findings by risk (likelihood × impact). Create a phased remediation plan with effort estimates, ownership assignments, and verification criteria.

Be specific about technical details. Include CVE numbers where applicable. Rate findings using CVSS 3.1. Format as a formal security audit report.`,
    gen: () => ({
      target: pk(repos),
      scope: pk(['Full application security review', 'API security assessment', 'Infrastructure audit', 'Authentication and authorization review', 'Third-party integration security']),
      lastAudit: rdate(),
      recentChanges: pk(['Major auth refactor', 'New API endpoints added', 'Cloud migration completed', 'Third-party SSO integration', 'Database encryption enabled']),
      knownIssues: `${ri(0, 5)} open findings from previous audit, ${ri(0, 10)} dependency CVEs in backlog`,
    }),
  },
  {
    name: 'hiring-decision-agent',
    desc: 'Full candidate evaluation with skills match, culture fit, and compensation analysis',
    objective: 'talent-acquisition',
    maxIterations: 4,
    systemPrompt: `You are a senior talent acquisition partner conducting a comprehensive candidate evaluation. Your process:

1. SKILLS ASSESSMENT: Evaluate technical and professional skills against role requirements. Score each required skill (1-5). Identify exceptional strengths and critical gaps. Compare to the existing team's skill distribution.
2. EXPERIENCE ANALYSIS: Assess career trajectory, company pedigree, project complexity, leadership experience, and domain expertise. Look for patterns of growth and impact.
3. CULTURE & TEAM FIT: Evaluate collaboration style, communication skills, work preferences, and values alignment. Consider team dynamics and diversity dimensions. Note any reference check insights.
4. COMPENSATION & OFFER STRATEGY: Benchmark against market data for the role/level/location. Analyze their current compensation, likely expectations, and competitive offers. Recommend offer structure (base, bonus, equity) with negotiation strategy.

Be data-driven. Reference specific examples from interviews. Score overall fit as Strong Hire / Hire / Lean No / No Hire with detailed justification. Flag any concerns that require additional diligence.`,
    gen: () => ({
      candidate: pk(people),
      role: pk(roles),
      level: pk(['IC3', 'IC4', 'IC5', 'M1', 'M2']),
      department: pk(depts),
      interviewScores: `Technical: ${ri(2, 5)}/5, System Design: ${ri(2, 5)}/5, Behavioral: ${ri(2, 5)}/5, Culture: ${ri(2, 5)}/5`,
      experience: `${ri(3, 15)} years, currently at ${pk(companies)} as ${pk(roles)}`,
      currentComp: money(120000, 300000),
      competingOffers: pk(['None known', `${pk(companies)} — verbal offer`, '2 competing offers in final stage', 'Counteroffer expected from current employer']),
    }),
  },
  {
    name: 'product-roadmap-agent',
    desc: 'Feature prioritization using impact/effort scoring across multiple iterations',
    objective: 'product-quality',
    maxIterations: 8,
    systemPrompt: `You are a senior product manager conducting quarterly roadmap prioritization. Your process:

1. FEATURE INVENTORY: Catalog all proposed features from customer requests, sales feedback, engineering proposals, and strategic initiatives. Deduplicate and normalize.
2. IMPACT SCORING: Score each feature on: revenue impact (direct and indirect), customer retention impact, competitive differentiation, strategic alignment, and time-sensitivity. Use a 1-10 scale with specific justification.
3. EFFORT ESTIMATION: Estimate engineering effort for each feature — development weeks, required expertise, dependencies, risk/uncertainty factor, and maintenance burden. Validate with tech lead estimates.
4. PRIORITIZATION FRAMEWORK: Apply RICE scoring (Reach × Impact × Confidence / Effort) or similar framework. Create a ranked backlog with quartile groupings: must-do, should-do, could-do, won't-do.
5. ROADMAP CONSTRUCTION: Sequence features across the quarter considering dependencies, resource constraints, and strategic milestones. Identify the critical path and buffer allocation.
6. STAKEHOLDER NARRATIVE: For each prioritized item, prepare the "why" narrative. For each deprioritized item, prepare the rationale. Draft the roadmap communication.

Be rigorous with scoring. Show the math. Highlight trade-offs explicitly. Format as a roadmap proposal with executive summary.`,
    gen: () => ({
      quarter: `Q${ri(2, 4)} 2026`,
      featureRequests: `${ri(20, 50)} items from ${ri(5, 15)} sources`,
      topRequests: `${pk(['AI-powered search', 'Custom dashboards', 'API v2', 'Mobile app', 'SSO improvements', 'Bulk operations'])}, ${pk(['Webhook management', 'Advanced reporting', 'Multi-tenant support', 'Real-time collaboration', 'Audit trail'])}`,
      constraints: `${ri(8, 20)} engineers available, ${pk(['1 major dependency on infrastructure team', 'No constraints', '2 engineers on leave', 'Hiring 3 mid-quarter'])}`,
      strategicContext: `Company focus: ${pk(['Enterprise expansion', 'Developer experience', 'Platform reliability', 'International growth', 'Cost optimization'])}`,
    }),
  },
  {
    name: 'incident-response-agent',
    desc: 'Systematic incident investigation with timeline, root cause, and remediation',
    objective: 'product-quality',
    maxIterations: 5,
    systemPrompt: `You are a senior SRE leading incident response. Your process:

1. TIMELINE RECONSTRUCTION: Build a precise timeline from first signal to resolution. Include: initial alert, acknowledgment, diagnosis steps, escalations, mitigation actions, and full resolution. Note any gaps or delays.
2. BLAST RADIUS ASSESSMENT: Determine full impact — affected services, user count, data integrity, financial impact, SLA implications, and downstream system effects. Distinguish confirmed vs suspected impact.
3. ROOT CAUSE ANALYSIS: Apply the "5 Whys" methodology. Distinguish between proximate cause, contributing factors, and systemic root cause. Identify what controls should have prevented or detected the issue earlier.
4. REMEDIATION ACTIONS: Define immediate fixes (already applied), short-term hardening (next sprint), and long-term systemic improvements. Each action needs: owner, deadline, verification criteria, and priority.
5. POSTMORTEM DOCUMENTATION: Draft a blameless postmortem covering: summary, impact, timeline, root cause, action items, lessons learned, and follow-up schedule.

Be precise with timestamps. Quantify impact in user-hours, revenue, and SLA budget consumed. Rate the incident response effectiveness and identify process improvements.`,
    gen: () => ({
      incident: `INC-${ri(100, 999)}`,
      severity: pk(severities),
      service: pk(repos),
      duration: `${ri(10, 240)} minutes`,
      impact: `${ri(100, 10000)} users affected, ${ri(0, 50000)} failed requests, estimated revenue impact: ${money(0, 50000)}`,
      symptoms: pk(['API 500 errors spiking', 'Database connection timeouts', 'Authentication failures', 'Data inconsistency detected', 'Service unreachable']),
      initialResponse: pk(['PagerDuty alert triggered', 'Customer reported via support', 'Detected in canary deployment', 'Monitoring dashboard anomaly']),
    }),
  },
  {
    name: 'contract-negotiation-agent',
    desc: 'Multi-clause contract analysis with risk scoring and negotiation recommendations',
    objective: 'compliance',
    maxIterations: 6,
    systemPrompt: `You are senior legal counsel leading contract negotiations. Your process:

1. CLAUSE-BY-CLAUSE ANALYSIS: Review every material clause. For each: identify the business impact, compare to our standard position, flag deviations, and classify risk (high/medium/low).
2. RED LINE IDENTIFICATION: Identify non-negotiable "red lines" — terms we cannot accept under any circumstances (unlimited liability, broad IP assignment, unilateral termination, etc.). Explain why each is a red line.
3. RISK MATRIX: Build a risk matrix covering: financial exposure, operational burden, compliance implications, IP protection, and exit strategy. Score each dimension 1-10.
4. NEGOTIATION STRATEGY: For each contentious clause, prepare: our ideal position, acceptable compromise, walk-away point, and suggested language. Anticipate counterarguments.
5. CONCESSION PLANNING: Identify low-value concessions we can offer in exchange for critical terms. Map trade-offs and develop a negotiation sequence.
6. EXECUTIVE SUMMARY: Synthesize into a go/no-go recommendation with conditions. Include estimated negotiation timeline and escalation triggers.

Be precise about contractual language. Reference market-standard terms. Quantify financial exposure where possible. Format as a negotiation brief.`,
    gen: () => ({
      contractType: pk(['Enterprise SaaS agreement', 'Strategic partnership', 'Data processing agreement', 'Reseller agreement', 'Joint development agreement']),
      counterparty: pk(companies),
      value: money(100000, 5000000),
      term: `${pk([12, 24, 36, 60])} months`,
      keyIssues: `${pk(['Liability cap at 12 months fees only', 'Broad IP assignment clause', 'Right to audit with 5 days notice', 'Termination for convenience with 30-day notice', 'Unlimited indemnification for data breach'])}; ${pk(['Non-standard SLA penalties', 'Restrictive non-compete', 'Most-favored-nation pricing clause', 'Mandatory arbitration in counterparty jurisdiction'])}`,
      deadline: rdate(),
    }),
  },
  {
    name: 'strategic-planning-agent',
    desc: 'Business strategy development with SWOT analysis and 90-day priorities',
    objective: 'operational-visibility',
    maxIterations: 7,
    systemPrompt: `You are a senior strategy consultant developing a quarterly business strategy. Your process:

1. SITUATION ANALYSIS: Assess current business performance — revenue trajectory, customer metrics, product maturity, team capacity, and competitive position. Identify what's working and what isn't.
2. SWOT ANALYSIS: Conduct rigorous SWOT — internal strengths/weaknesses grounded in data, external opportunities/threats backed by market evidence. Prioritize each quadrant by impact.
3. STRATEGIC OPTIONS: Generate 3-5 strategic options for the next quarter. For each: describe the approach, required investment, expected outcomes, key risks, and success metrics. Include a "do nothing" baseline.
4. OPTION EVALUATION: Evaluate each option against: strategic fit, resource feasibility, risk/reward profile, competitive timing, and organizational readiness. Use a weighted scoring matrix.
5. RECOMMENDATION: Select and justify the recommended strategy. Define: 90-day priorities (3-5 initiatives), resource allocation, key milestones, success metrics, and kill criteria.
6. EXECUTION FRAMEWORK: Create an execution plan with: weekly checkpoints, monthly reviews, escalation triggers, and communication cadence. Assign executive sponsors for each initiative.
7. RISK MITIGATION: For each priority, identify top 3 risks and pre-planned mitigations. Define contingency plans for the most likely failure modes.

Be specific with numbers and timelines. Challenge assumptions. Distinguish between "must win" battles and "nice to win" opportunities. Format as a strategy memo for the executive team.`,
    gen: () => ({
      company: 'Our company',
      context: `${pk(['Series B', 'Series C', 'Growth stage', 'Public'])} company in ${pk(industries).toLowerCase()}. ARR: ${money(10000000, 100000000)}, Growth: ${ri(20, 100)}% YoY, Headcount: ${ri(100, 1000)}.`,
      currentChallenges: `${pk(['Slowing growth rate', 'Increasing competition', 'Key talent departures', 'Product-market fit questions in new segment', 'Rising customer acquisition costs'])}. ${pk(['Need to demonstrate path to profitability', 'Board pressure to expand internationally', 'Technical debt limiting feature velocity', 'Customer concentration risk'])}`,
      marketDynamics: `${pk(['Market consolidation accelerating', 'New regulatory requirements emerging', 'AI disrupting traditional approaches', 'Enterprise budgets tightening', 'New market entrants with venture backing'])}`,
      quarter: `Q${ri(2, 4)} 2026`,
    }),
  },
];

// ── Main export ──────────────────────────────────────────────────────────────

export function startDemoSimulation(
  engine: Engine,
  createAgentHandler: AgentHandlerFactory,
  simTimers: ReturnType<typeof setTimeout>[],
  mockProviders?: MockProvider[],
): void {
  console.log('[demo] Initializing demo simulation...');

  // ── Register 80 prompt flows ──
  const allPromptFlows: Array<{ name: string; dept: string; gen: () => Record<string, unknown> }> = [];

  for (const [dept, { objective, flows }] of Object.entries(deptFlows)) {
    const context = ctx[dept];
    for (const f of flows) {
      const fullTemplate = `${context}\n\n${f.tpl}`;
      engine.register(f.name, async (execCtx: any) => {
        const input = (execCtx.input ?? {}) as Record<string, unknown>;
        const prompt = fullTemplate.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => String(input[k] ?? ''));
        const result = await execCtx.model.complete({ prompt });
        return { input, output: result.text, model: result.model };
      }, { description: f.desc, objective, enforceable: false });
      allPromptFlows.push({ name: f.name, dept, gen: f.gen });
    }
  }

  // ── Register 10 agent flows ──
  for (const a of agentFlowDefs) {
    engine.register(a.name, createAgentHandler({
      systemPrompt: a.systemPrompt,
      maxIterations: a.maxIterations,
    }), { description: a.desc, objective: a.objective, enforceable: false });
  }

  console.log(`[demo] Registered ${allPromptFlows.length} prompt flows + ${agentFlowDefs.length} agent flows (${allPromptFlows.length + agentFlowDefs.length} total, ${allPromptFlows.length + agentFlowDefs.length + 5} with pre-registered)`);

  // ── Simulation users ──
  const users = [
    { name: 'alice', department: 'finance' },
    { name: 'bob', department: 'sales' },
    { name: 'carol', department: 'hr' },
    { name: 'david', department: 'engineering' },
    { name: 'eve', department: 'marketing' },
    { name: 'frank', department: 'legal' },
    { name: 'grace', department: 'support' },
    { name: 'henry', department: 'operations' },
  ];

  const flowsByDept = new Map<string, typeof allPromptFlows>();
  for (const f of allPromptFlows) {
    if (!flowsByDept.has(f.dept)) flowsByDept.set(f.dept, []);
    flowsByDept.get(f.dept)!.push(f);
  }

  // ── Activity wave (sine over 10-minute cycle) ──
  const simStart = Date.now();

  function getIntervalMs(): number {
    const elapsed = (Date.now() - simStart) / 1000;
    const phase = (elapsed % 600) / 600;
    const wave = Math.sin(phase * 2 * Math.PI);
    // wave: -1 (low) to 1 (high activity)
    // High: ~7s (8-9/min), Low: ~45s (1.3/min)
    const t = (wave + 1) / 2;
    return 45000 - t * 38000;
  }

  // ── Prompt flow trigger loop ──
  async function triggerRandomFlow() {
    const user = pk(users);
    const dept = Math.random() < 0.8 ? user.department : pk(users).department;
    const deptList = flowsByDept.get(dept);
    if (!deptList || deptList.length === 0) return;
    const flow = pk(deptList);
    try {
      await engine.trigger(flow.name, {
        idempotencyKey: `sim-${rid()}`,
        input: flow.gen(),
        userId: user.name,
      });
    } catch { /* ignore simulation errors */ }
  }

  function scheduleNextTrigger() {
    const interval = getIntervalMs();
    const timer = setTimeout(async () => {
      await triggerRandomFlow();
      scheduleNextTrigger();
    }, interval);
    simTimers.push(timer);
  }

  scheduleNextTrigger();

  // ── Agent simulation loops (each on independent 3-5 min interval) ──
  for (const agent of agentFlowDefs) {
    const intervalMs = ri(180000, 300000);

    // Fire once immediately
    engine.trigger(agent.name, {
      idempotencyKey: `sim-agent-init-${agent.name}-${rid()}`,
      input: agent.gen(),
      userId: pk(users).name,
    }).catch(() => {});

    const timer = setInterval(async () => {
      try {
        await engine.trigger(agent.name, {
          idempotencyKey: `sim-agent-${rid()}`,
          input: agent.gen(),
          userId: pk(users).name,
        });
      } catch { /* ignore */ }
    }, intervalMs);
    simTimers.push(timer);
  }

  // ── Discernment cycles (once now, then every 5 min) ──
  // Queue realistic recommendations so MockProvider returns meaningful discernment results
  function queueDiscernmentResponse() {
    if (!mockProviders || mockProviders.length === 0) return;
    const actions = ['optimize', 'keep', 'investigate', 'escalate', 'reduce'] as const;
    const targets = [
      ...Object.values(deptFlows).flatMap(d => d.flows.slice(0, 2).map(f => ({ target: f.name, targetType: 'flow' as const }))),
      ...agentFlowDefs.slice(0, 3).map(a => ({ target: a.name, targetType: 'flow' as const })),
      { target: 'customer-retention', targetType: 'objective' as const },
      { target: 'cost-optimization', targetType: 'objective' as const },
      { target: 'revenue-growth', targetType: 'objective' as const },
    ];
    const selected = targets.sort(() => Math.random() - 0.5).slice(0, ri(4, 8));
    const recommendations = selected.map(t => ({
      target: t.target,
      targetType: t.targetType,
      action: pk([...actions]),
      confidence: +(0.6 + Math.random() * 0.35).toFixed(2),
      explanation: `${t.target} ${t.targetType === 'objective' ? 'objective alignment' : 'flow performance'} analysis suggests ${pk([...actions])} action. ${pk(['Cost per execution is trending up.', 'Usage volume is below threshold.', 'Strong alignment with business objectives.', 'Consider consolidating with related flows.', 'Execution latency has increased 15% week-over-week.', 'Token usage could be reduced with prompt optimization.'])}`,
      evidenceRefs: [],
    }));
    const payload = [{ text: JSON.stringify({ recommendations }) }];
    for (const mp of mockProviders) mp.queueResponses(payload);
  }

  // Delay initial cycle to let agent triggers complete (MockProvider is instant but async)
  const initDiscernTimer = setTimeout(() => {
    queueDiscernmentResponse();
    engine.runDiscernmentCycle().catch(() => {});
  }, 5000);
  simTimers.push(initDiscernTimer);
  const discernTimer = setInterval(() => {
    queueDiscernmentResponse();
    engine.runDiscernmentCycle().catch(() => {});
  }, 300000);
  simTimers.push(discernTimer);

  console.log('[demo] Simulation started — activity cycles over 10 min, agents fire every 3-5 min, discernment every 5 min.');
}
