import type { DerivedFact } from '../domain/types'
import { f } from '../engine/conditions'

const kind = (id: string) => f.eq('project.kind', id)
const addon = (id: string) => f.inc('project.addons', id)

// Profile flags carry the kind of task, so question sets gate on a flag and never name a kind themselves.
// A pending kind counts as a transactional app: it keeps the request path and sets no other flag.
// A SaaS CRM bought to replace the old one is the whole new system unless an application or AI features are built beside it.
const boughtCrm = f.all(
  f.in('project.origin', ['migrate_database', 'replace_legacy_app', 'modernize_app']),
  f.eq('migration.approach', 'repurchase'),
  f.inc('source.kinds', 'crm'),
  f.not(f.inc('source.kinds', 'legacy_app')),
  f.not(f.any(kind('ai_app'), addon('ai'))),
)

export const derived: DerivedFact[] = [
  { fact: 'profile.requestPath', value: false, when: f.any(kind('data_platform'), boughtCrm) },
  { fact: 'profile.requestPath', value: true, when: f.not(kind('data_platform')) },
  { fact: 'profile.dataPlatform', value: true, when: f.any(kind('data_platform'), addon('analytics')) },
  // The task is the data platform itself, whatever the migration answers: questions that profile.requestPath follows cannot gate the approach that sets it.
  { fact: 'profile.dataPlatformOnly', value: true, when: kind('data_platform') },
  { fact: 'profile.ai', value: true, when: f.any(kind('ai_app'), addon('ai')) },
  // The AI app reads no copy of the system it builds on: agents look records up live through tools, or a chat-only app (no retrieval, no agents, no lake) reads none.
  {
    fact: 'profile.keptUncopied',
    value: true,
    when: f.all(
      f.eq('project.origin', 'extend_existing'),
      f.any(
        f.eq('ai.existing_data', 'live_tools'),
        f.all(kind('ai_app'), f.exists('ai.capabilities'), f.not(f.inc('ai.capabilities', 'rag_documents')), f.not(f.inc('ai.capabilities', 'agent_actions')), f.ne('profile.dataPlatform', true)),
      ),
    ),
  },
  // A language model is in the design: the LLM path of ml.serving, or the AI add-on, which brings its own model whatever ml.serving serves
  // (batch recommendations beside an assistant). An AI app on classic batch or online models has none.
  { fact: 'profile.llm', value: true, when: f.any(f.eq('ml.serving', 'llm_api'), addon('ai')) },
  // Many customer companies share one deployment, so tenant isolation is a design decision.
  { fact: 'profile.multiTenant', value: true, when: kind('b2b_saas') },
  { fact: 'profile.integration', value: true, when: f.any(kind('integration'), addon('integration')) },
  { fact: 'profile.events', value: true, when: f.any(kind('event_streaming'), addon('event_ingest')) },
  // A pending origin counts as a new build, so no migration question or component appears before it is answered.
  { fact: 'profile.migration', value: true, when: f.in('project.origin', ['migrate_database', 'replace_legacy_app', 'modernize_app', 'extend_existing']) },
  // These origins retire the old system, so its data moves into the new database and the move has a cutover and a rollback.
  { fact: 'profile.replace', value: true, when: f.in('project.origin', ['migrate_database', 'replace_legacy_app', 'modernize_app']) },
  // Retaining keeps the old system for good, so only the other approaches switch it off: its row, feeds and bill are transition-phase and the move pays back.
  { fact: 'profile.retire', value: true, when: f.all(f.eq('profile.replace', true), f.ne('migration.approach', 'retain')) },
  // A migration loads a database of known size into a relational engine (kept or converted), so the schema stays on one instance up to the engine's own size limit
  // instead of splitting at the planning size a new build grows into.
  { fact: 'migration.loadsRelationalDb', value: true, when: f.all(f.eq('profile.replace', true), f.in('data.primary_db', ['postgres', 'mysql', 'sqlserver', 'oracle'])) },
  // A home-grown or packaged on-premises CRM runs on a database of its own; only the SaaS CRMs are read through their APIs.
  { fact: 'source.crmOnDatabase', value: true, when: f.all(f.inc('source.kinds', 'crm'), f.in('source.crm_product', ['custom', 'dynamics_onprem', 'packaged_onprem'])) },
  // Such a CRM and a legacy application have an engine, database code and a transaction log like any database source.
  { fact: 'source.database', value: true, when: f.any(f.inc('source.kinds', 'rdbms'), f.inc('source.kinds', 'legacy_app'), f.eq('source.crmOnDatabase', true)) },
  // The source runs in the provider the new system runs on, so copies stay inside its network; a source in any other cloud bills egress once on leaving it.
  { fact: 'source.inTargetCloud', value: true, when: f.any(...['aws', 'azure', 'gcp'].map((cloud) => f.all(f.eq('source.location', cloud), f.eq('infra.cloud', cloud)))) },
  { fact: 'source.leavesCloud', value: true, when: f.all(f.in('source.location', ['aws', 'azure', 'gcp', 'other_cloud']), f.ne('source.inTargetCloud', true)) },
  // Live tracking apps hold a connection per client and report positions, as workload.ts assumes.
  { fact: 'traffic.liveTracking', value: true, when: f.all(f.eq('product.type', 'mobility'), f.inc('product.features', 'geo')) },
  // Video reaches viewers only through the CDN, which availability.ts keeps in series with the regions.
  { fact: 'perf.mediaStreaming', value: true, when: f.eq('product.type', 'streaming') },
  // Cloud fleets scale in and out with the load, so they bill the average fleet (architecture.ts); own hardware and pinned fleets are bought for the peak.
  { fact: 'compute.autoscaled', value: true, when: f.all(f.in('infra.cloud', ['aws', 'azure', 'gcp']), f.in('infra.compute', ['paas', 'managed_containers', 'kubernetes', 'vms'])) },
]
