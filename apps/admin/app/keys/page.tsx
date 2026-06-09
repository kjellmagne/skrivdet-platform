"use client";

import { useEffect, useState } from "react";
import { Copy, Eye, KeyRound, ShieldCheck, ShieldX, Trash2 } from "lucide-react";
import { RequireAuth } from "../../components/RequireAuth";
import { EmptyState, FieldLabel, FormSection, IconAction, LoadingPanel, PageHeader, PanelHeader, SidePanel, StatusBadge } from "../../components/AdminUI";
import { getErrorMessage, useToast } from "../../components/ToastProvider";
import { api } from "../../lib/api";

function defaultMaintenanceDate() {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

type KeyTab = "single" | "enterprise";

export default function KeysPage() {
  const [single, setSingle] = useState<any[]>([]);
  const [enterprise, setEnterprise] = useState<any[]>([]);
  const [tenants, setTenants] = useState<any[]>([]);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [partners, setPartners] = useState<any[]>([]);
  const [generated, setGenerated] = useState<{ key: string; kind: "single-user" | "enterprise"; label: string } | null>(null);
  const [form, setForm] = useState({ purchaserFullName: "", purchaserEmail: "", maintenanceUntil: defaultMaintenanceDate(), partnerId: "", notes: "" });
  const [enterpriseForm, setEnterpriseForm] = useState({ tenantId: "", configProfileId: "", maxDevices: 25, maintenanceUntil: defaultMaintenanceDate() });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [singleModalOpen, setSingleModalOpen] = useState(false);
  const [enterpriseModalOpen, setEnterpriseModalOpen] = useState(false);
  const [details, setDetails] = useState<{ kind: "single" | "enterprise"; key: any } | null>(null);
  const [activeTab, setActiveTab] = useState<KeyTab>("single");
  const { notify } = useToast();

  async function load() {
    try {
      const [s, e, t, p, partnerData] = await Promise.all([api("/admin/single-keys"), api("/admin/enterprise-keys"), api("/admin/tenants"), api("/admin/config-profiles"), api("/admin/partners")]);
      setSingle(s); setEnterprise(e); setTenants(t); setProfiles(p); setPartners(partnerData);
      setEnterpriseForm((v) => ({ ...v, tenantId: v.tenantId || t[0]?.id || "", configProfileId: v.configProfileId || p[0]?.id || "" }));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load().catch((err) => notify({ tone: "danger", title: "Could not load license keys", message: getErrorMessage(err) })); }, []);

  async function createSingle(e: React.FormEvent) {
    e.preventDefault();
    setSaving("single");
    try {
      const res = await api("/admin/single-keys", { method: "POST", body: JSON.stringify({ ...form, partnerId: form.partnerId || undefined }) });
      setGenerated({ key: res.activationKey, kind: "single-user", label: form.purchaserEmail });
      setActiveTab("single");
      notify({ tone: "success", title: "Single-user key generated", message: "Store the activation key now. It will not be shown again." });
      setForm({ purchaserFullName: "", purchaserEmail: "", maintenanceUntil: defaultMaintenanceDate(), partnerId: "", notes: "" });
      setSingleModalOpen(false);
      await load();
    } catch (err: any) {
      notify({ tone: "danger", title: "Could not generate key", message: getErrorMessage(err) });
    } finally {
      setSaving("");
    }
  }
  async function createEnterprise(e: React.FormEvent) {
    e.preventDefault();
    setSaving("enterprise");
    try {
      const res = await api("/admin/enterprise-keys", { method: "POST", body: JSON.stringify(enterpriseForm) });
      setGenerated({ key: res.activationKey, kind: "enterprise", label: res.tenant?.name ?? "Enterprise tenant" });
      setActiveTab("enterprise");
      notify({ tone: "success", title: "Enterprise key generated", message: "Store the activation key now. It will not be shown again." });
      setEnterpriseModalOpen(false);
      await load();
    } catch (err: any) {
      notify({ tone: "danger", title: "Could not generate key", message: getErrorMessage(err) });
    } finally {
      setSaving("");
    }
  }

  async function deleteEnterpriseActivation(activation: any) {
    if (!window.confirm(`Delete activation for ${activation.deviceIdentifier}? This frees one enterprise device slot.`)) return;
    try {
      await api(`/admin/activations/${activation.id}`, { method: "DELETE" });
      setDetails((current) => {
        if (current?.kind !== "enterprise") return current;
        return { ...current, key: { ...current.key, activations: (current.key.activations ?? []).filter((item: any) => item.id !== activation.id) } };
      });
      notify({ tone: "success", title: "Device activation deleted" });
      await load();
    } catch (err: any) {
      notify({ tone: "danger", title: "Could not delete activation", message: getErrorMessage(err) });
    }
  }

  async function deleteSingleKey(key: any) {
    if (!window.confirm(`Delete single-user key ${key.keyPrefix}? This also removes any device activation for this key.`)) return;
    try {
      await api(`/admin/single-keys/${key.id}`, { method: "DELETE" });
      setDetails((current) => current?.key?.id === key.id ? null : current);
      notify({ tone: "success", title: "Single-user key deleted" });
      await load();
    } catch (err: any) {
      notify({ tone: "danger", title: "Could not delete key", message: getErrorMessage(err) });
    }
  }

  async function deleteEnterpriseKey(key: any) {
    if (!window.confirm(`Delete enterprise key ${key.keyPrefix}? This also removes ${key.activations?.length ?? 0} device activation(s).`)) return;
    try {
      await api(`/admin/enterprise-keys/${key.id}`, { method: "DELETE" });
      setDetails((current) => current?.key?.id === key.id ? null : current);
      notify({ tone: "success", title: "Enterprise key deleted" });
      await load();
    } catch (err: any) {
      notify({ tone: "danger", title: "Could not delete key", message: getErrorMessage(err) });
    }
  }

  async function toggleSingleKey(key: any) {
    try {
      await api(`/admin/single-keys/${key.id}/revoke`, { method: "PATCH" });
      notify({ tone: "success", title: key.status === "revoked" ? "License reactivated" : "License revoked" });
      await load();
    } catch (err: any) {
      notify({ tone: "danger", title: "Could not update license", message: getErrorMessage(err) });
    }
  }

  return (
    <RequireAuth>
      <PageHeader
        title="License keys"
        description="Generate, inspect, revoke/reactivate, and delete activation keys. Full keys are shown once after generation."
      />
      {generated && (
        <div className="panel" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
          <PanelHeader
            title="Activation key generated"
            description={`${generated.kind} key for ${generated.label}. Store it now; the full key is not saved in plain text.`}
            actions={<IconAction label="Copy activation key" tone="primary" onClick={() => navigator.clipboard.writeText(generated.key).then(() => notify({ tone: "success", title: "Activation key copied" }))}><Copy size={16} /></IconAction>}
          />
          <input className="input" readOnly value={generated.key} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 800 }} />
        </div>
      )}
      {loading ? <LoadingPanel label="Loading license keys" /> : (
        <>
          <div className="page-stack">
            <div className="license-tabs" role="tablist" aria-label="License key type">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "single"}
                className={activeTab === "single" ? "active" : undefined}
                onClick={() => setActiveTab("single")}
              >
                <KeyRound size={16} />
                <span>Single-user keys</span>
                <span className="tab-count">{single.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "enterprise"}
                className={activeTab === "enterprise" ? "active" : undefined}
                onClick={() => setActiveTab("enterprise")}
              >
                <ShieldCheck size={16} />
                <span>Enterprise keys</span>
                <span className="tab-count">{enterprise.length}</span>
              </button>
            </div>

            {activeTab === "single" && (
            <div className="panel">
              <PanelHeader
                title="Single-user keys"
                description="Double-click a row to view all associated details. Full activation keys are hashed and cannot be recovered later."
                actions={<button type="button" className="button" onClick={() => setSingleModalOpen(true)}><KeyRound size={15} /> Generate key</button>}
              />
              {!single.length ? <EmptyState title="No single-user keys" message="Generate a key above to make it available for activation." /> : (
                <div className="table-wrap"><table className="table"><thead><tr><th>Purchaser</th><th>Partner</th><th>Prefix</th><th>Status</th><th>Maintenance</th><th>Device</th><th className="actions">Actions</th></tr></thead><tbody>{single.map((k) => <tr key={k.id} className="clickable-row" title="Double-click to view license details" onDoubleClick={() => setDetails({ kind: "single", key: k })}><td><b>{k.purchaserFullName}</b><br /><span className="muted">{k.purchaserEmail}</span></td><td>{k.partner?.name ?? <span className="muted">Internal</span>}</td><td>{k.keyPrefix}</td><td><StatusBadge status={k.status} /></td><td>{formatDate(k.maintenanceUntil)}</td><td>{k.deviceIdentifier ?? "-"}</td><td className="row actions"><IconAction label="View license details" onClick={() => setDetails({ kind: "single", key: k })}><Eye size={14} /></IconAction><IconAction label={k.status === "revoked" ? "Reactivate license" : "Revoke license"} onClick={() => toggleSingleKey(k)}>{k.status === "revoked" ? <ShieldCheck size={14} /> : <ShieldX size={14} />}</IconAction><IconAction label="Delete key" tone="danger" onClick={() => deleteSingleKey(k)}><Trash2 size={14} /></IconAction></td></tr>)}</tbody></table></div>
              )}
            </div>
            )}

            {activeTab === "enterprise" && (
            <div className="panel">
              <PanelHeader
                title="Enterprise keys"
                description="Double-click a row to inspect tenant, config, and device activation details."
                actions={<button type="button" className="button" onClick={() => setEnterpriseModalOpen(true)} disabled={!tenants.length || !profiles.length}><KeyRound size={15} /> Generate key</button>}
              />
              {!enterprise.length ? <EmptyState title="No enterprise keys" message="Create a tenant and config profile, then generate an enterprise key." /> : (
                <div className="table-wrap"><table className="table"><thead><tr><th>Tenant</th><th>Partner</th><th>Prefix</th><th>Status</th><th>Maintenance</th><th>Devices</th><th>Effective config</th><th className="actions">Actions</th></tr></thead><tbody>{enterprise.map((k) => <tr key={k.id} className="clickable-row" title="Double-click to view license details" onDoubleClick={() => setDetails({ kind: "enterprise", key: k })}><td><b>{k.tenant?.name}</b></td><td>{k.partner?.name ?? <span className="muted">Internal</span>}</td><td>{k.keyPrefix}</td><td><StatusBadge status={k.status} /></td><td>{formatDate(k.maintenanceUntil)}</td><td>{k.activations?.length ?? 0}/{k.maxDevices ?? "unlimited"}</td><td>{effectiveEnterpriseConfigProfile(k)?.name ?? "-"}</td><td className="row actions"><IconAction label="View license details" onClick={() => setDetails({ kind: "enterprise", key: k })}><Eye size={14} /></IconAction><IconAction label="Delete key" tone="danger" onClick={() => deleteEnterpriseKey(k)}><Trash2 size={14} /></IconAction></td></tr>)}</tbody></table></div>
              )}
            </div>
            )}
          </div>
          <SidePanel
            open={singleModalOpen}
            title="Generate single-user key"
            description="For one purchaser and one bound device in v1."
            onClose={() => saving !== "single" && setSingleModalOpen(false)}
            footer={(
              <>
                <button type="button" className="button secondary" onClick={() => setSingleModalOpen(false)} disabled={saving === "single"}>Cancel</button>
                <button type="submit" form="single-key-form" className="button" disabled={saving === "single"}><KeyRound size={16} /> {saving === "single" ? "Generating..." : "Generate key"}</button>
              </>
            )}
          >
            <form id="single-key-form" onSubmit={createSingle} className="form-stack">
              <FormSection title="Registered purchaser" description="Who the single-user license is issued to.">
                <div className="grid two">
                  <div className="field"><FieldLabel>Purchaser full name</FieldLabel><input className="input" placeholder="Ola Nordmann" value={form.purchaserFullName} onChange={(e) => setForm({ ...form, purchaserFullName: e.target.value })} required /></div>
                  <div className="field"><FieldLabel>Email</FieldLabel><input className="input" placeholder="ola@example.com" type="email" value={form.purchaserEmail} onChange={(e) => setForm({ ...form, purchaserEmail: e.target.value })} required /></div>
                </div>
              </FormSection>
              <FormSection title="Coverage and ownership" description="Maintenance status and optional partner scope.">
                <div className="grid two">
                  <div className="field"><FieldLabel help="Shown to the iPhone app as support coverage.">Maintenance until</FieldLabel><input className="input" type="date" value={form.maintenanceUntil} onChange={(e) => setForm({ ...form, maintenanceUntil: e.target.value })} /></div>
                  <div className="field"><FieldLabel help="Partner admins assigned to this solution partner can manage this key.">Solution partner</FieldLabel><select value={form.partnerId} onChange={(e) => setForm({ ...form, partnerId: e.target.value })}><option value="">Internal / no partner</option>{partners.map((partner) => <option key={partner.id} value={partner.id}>{partner.name}</option>)}</select></div>
                </div>
              </FormSection>
              <FormSection title="Internal notes" description="Optional context for staff and partner admins.">
                <div className="field"><FieldLabel>Notes</FieldLabel><input className="input" placeholder="Internal context or purchase reference" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
              </FormSection>
            </form>
          </SidePanel>
          <SidePanel
            open={enterpriseModalOpen}
            title="Generate enterprise key"
            description="Links a tenant, device allowance, and central config profile."
            onClose={() => saving !== "enterprise" && setEnterpriseModalOpen(false)}
            footer={(
              <>
                <button type="button" className="button secondary" onClick={() => setEnterpriseModalOpen(false)} disabled={saving === "enterprise"}>Cancel</button>
                <button type="submit" form="enterprise-key-form" className="button" disabled={saving === "enterprise" || !tenants.length || !profiles.length}><KeyRound size={16} /> {saving === "enterprise" ? "Generating..." : "Generate key"}</button>
              </>
            )}
          >
            <form id="enterprise-key-form" onSubmit={createEnterprise} className="form-stack">
              <FormSection title="Enterprise assignment" description="Choose the customer and central configuration this key activates.">
                <div className="grid two">
                  <div className="field"><FieldLabel>Tenant</FieldLabel><select value={enterpriseForm.tenantId} onChange={(e) => setEnterpriseForm({ ...enterpriseForm, tenantId: e.target.value })}>{tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
                  <div className="field"><FieldLabel help="Returned to the app after activation and refresh.">Config profile</FieldLabel><select value={enterpriseForm.configProfileId} onChange={(e) => setEnterpriseForm({ ...enterpriseForm, configProfileId: e.target.value })}>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
                </div>
              </FormSection>
              <FormSection title="Allowance and maintenance" description="Device capacity and support coverage shown in license details.">
                <div className="grid two">
                  <div className="field"><FieldLabel help="Leave blank in the API for unlimited.">Max devices</FieldLabel><input className="input" type="number" min={1} value={enterpriseForm.maxDevices} onChange={(e) => setEnterpriseForm({ ...enterpriseForm, maxDevices: Number(e.target.value) })} /></div>
                  <div className="field"><FieldLabel help="Shown to users as maintenance/support coverage.">Maintenance until</FieldLabel><input className="input" type="date" value={enterpriseForm.maintenanceUntil} onChange={(e) => setEnterpriseForm({ ...enterpriseForm, maintenanceUntil: e.target.value })} /></div>
                </div>
              </FormSection>
            </form>
          </SidePanel>
          <SidePanel
            open={Boolean(details)}
            title={details?.kind === "single" ? "Single-user license details" : "Enterprise license details"}
            description="Complete stored metadata for this license key. The full activation key cannot be recovered after generation."
            onClose={() => setDetails(null)}
          >
            {details?.kind === "single" && <SingleLicenseDetails licenseKey={details.key} />}
            {details?.kind === "enterprise" && <EnterpriseLicenseDetails licenseKey={details.key} onDeleteActivation={deleteEnterpriseActivation} />}
          </SidePanel>
        </>
      )}
    </RequireAuth>
  );
}

function SingleLicenseDetails({ licenseKey }: { licenseKey: any }) {
  return (
    <div className="details-stack">
      <DetailSection title="License overview" description="The stable identifiers and current state for this single-user key.">
        <Detail label="Status" value={<StatusBadge status={licenseKey.status} />} />
        <Detail label="Key prefix" value={licenseKey.keyPrefix} mono />
        <Detail label="License ID" value={licenseKey.id} mono wide />
      </DetailSection>
      <DetailSection title="Registered to" description="Commercial registration data shown in the mobile license details view.">
        <Detail label="Purchaser" value={licenseKey.purchaserFullName} />
        <Detail label="Email" value={licenseKey.purchaserEmail} />
        <Detail label="Solution partner" value={licenseKey.partner?.name ?? "Internal"} />
        <Detail label="Purchase date" value={formatDate(licenseKey.purchaseDate)} />
        <Detail label="Maintenance until" value={formatDate(licenseKey.maintenanceUntil)} />
        <Detail label="Expires at" value={formatDateTime(licenseKey.expiresAt)} />
      </DetailSection>
      <DetailSection title="Lifecycle" description="Server-side timestamps for generation, activation and record changes.">
        <Detail label="Generated at" value={formatDateTime(licenseKey.generatedAt)} />
        <Detail label="Activated at" value={formatDateTime(licenseKey.activatedAt)} />
        <Detail label="Created at" value={formatDateTime(licenseKey.createdAt)} />
        <Detail label="Updated at" value={formatDateTime(licenseKey.updatedAt)} />
      </DetailSection>
      <DetailSection title="Bound device" description="Single-user licenses bind to one device in v1.">
        <Detail label="Device identifier" value={licenseKey.deviceIdentifier} mono wide />
        <Detail label="Serial number" value={licenseKey.deviceSerialNumber} mono />
        <Detail label="App version" value={licenseKey.appVersion} />
        <Detail label="Last check-in" value={formatDateTime(licenseKey.lastCheckIn)} />
        <Detail label="Last seen" value={formatDateTime(licenseKey.lastSeenAt)} />
      </DetailSection>
      <Notes value={licenseKey.notes} />
      <ActivationDetails activations={licenseKey.activations ?? []} />
    </div>
  );
}

function EnterpriseLicenseDetails({ licenseKey, onDeleteActivation }: { licenseKey: any; onDeleteActivation: (activation: any) => void }) {
  const activeDevices = licenseKey.activations?.filter((activation: any) => activation.status === "active").length ?? 0;
  const availableDevices = licenseKey.maxDevices ? Math.max(licenseKey.maxDevices - activeDevices, 0) : "unlimited";
  const effectiveProfile = effectiveEnterpriseConfigProfile(licenseKey);
  const effectiveSource = licenseKey.tenant?.configProfile ? "Tenant assignment" : "License key fallback";

  return (
    <div className="details-stack">
      <DetailSection title="License overview" description="Key identity, status and device allowance for this enterprise license.">
        <Detail label="Status" value={<StatusBadge status={licenseKey.status} />} />
        <Detail label="Key prefix" value={licenseKey.keyPrefix} mono />
        <Detail label="License ID" value={licenseKey.id} mono wide />
        <Detail label="Max devices" value={licenseKey.maxDevices ?? "unlimited"} />
        <Detail label="Active devices" value={activeDevices} />
        <Detail label="Available devices" value={availableDevices} />
        <Detail label="Maintenance until" value={formatDate(licenseKey.maintenanceUntil)} />
        <Detail label="Expires at" value={formatDateTime(licenseKey.expiresAt)} />
        <Detail label="Solution partner" value={licenseKey.partner?.name ?? "Internal"} />
      </DetailSection>
      <DetailSection title="Tenant identity" description="The enterprise customer this key is attached to.">
        <Detail label="Tenant ID" value={licenseKey.tenant?.id} mono wide />
        <Detail label="Name" value={licenseKey.tenant?.name} />
        <Detail label="Slug" value={licenseKey.tenant?.slug} mono />
        <Detail label="Status" value={licenseKey.tenant?.status} />
        <Detail label="Legal name" value={licenseKey.tenant?.legalName} />
        <Detail label="Organization number" value={licenseKey.tenant?.organizationNumber} />
      </DetailSection>
      <DetailSection title="Tenant contacts" description="Operational and billing contact data for the customer.">
        <Detail label="Contact" value={licenseKey.tenant?.contactName} />
        <Detail label="Contact email" value={licenseKey.tenant?.contactEmail} />
        <Detail label="Contact phone" value={licenseKey.tenant?.contactPhone} />
        <Detail label="Billing email" value={licenseKey.tenant?.billingEmail} />
        <Detail label="City" value={licenseKey.tenant?.city} />
        <Detail label="Country" value={licenseKey.tenant?.country} />
      </DetailSection>
      <DetailSection title="Effective config profile" description="Central app configuration returned to enterprise devices on activation and refresh.">
        <Detail label="Source" value={effectiveSource} />
        <Detail label="Config ID" value={effectiveProfile?.id} mono wide />
        <Detail label="Name" value={effectiveProfile?.name} />
        <Detail label="Tenant profile" value={licenseKey.tenant?.configProfile?.name} />
        <Detail label="Key fallback profile" value={licenseKey.configProfile?.name} />
        <Detail label="Speech provider" value={effectiveProfile?.speechProviderType} />
        <Detail label="Speech model" value={effectiveProfile?.speechModelName} />
        <Detail label="Formatter" value={effectiveProfile?.documentGenerationProviderType} />
        <Detail label="Formatter model" value={effectiveProfile?.documentGenerationModel} />
        <Detail label="Privacy control" value={yesNo(effectiveProfile?.privacyControlEnabled)} />
        <Detail label="PII control" value={yesNo(effectiveProfile?.piiControlEnabled)} />
        <Detail label="Privacy review" value={effectiveProfile?.privacyReviewProviderType} />
        <Detail label="Template repository" value={effectiveProfile?.templateRepositoryUrl} mono full />
        <Detail label="Telemetry endpoint" value={effectiveProfile?.telemetryEndpointUrl} mono full />
      </DetailSection>
      <DetailSection title="Lifecycle" description="Server-side timestamps for generation and record changes.">
        <Detail label="Generated at" value={formatDateTime(licenseKey.generatedAt)} />
        <Detail label="Created at" value={formatDateTime(licenseKey.createdAt)} />
        <Detail label="Updated at" value={formatDateTime(licenseKey.updatedAt)} />
      </DetailSection>
      <Notes value={licenseKey.notes} />
      <ActivationDetails activations={licenseKey.activations ?? []} onDeleteActivation={onDeleteActivation} />
    </div>
  );
}

function ActivationDetails({ activations, onDeleteActivation }: { activations: any[]; onDeleteActivation?: (activation: any) => void }) {
  return (
    <section className="detail-section">
      <div className="detail-section-header">
        <div>
          <h3>Device activations</h3>
          <p>Registered app devices using this key. Delete an enterprise activation to free a device slot.</p>
        </div>
      </div>
      {!activations.length ? <EmptyState title="No activations" message="This key has not been used by a device yet." /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Device</th><th>Serial</th><th>Status</th><th>App</th><th>Activated</th><th>Last seen</th>{onDeleteActivation && <th className="actions">Actions</th>}</tr></thead>
            <tbody>{activations.map((activation) => (
              <tr key={activation.id}>
                <td><span className="code">{activation.deviceIdentifier}</span></td>
                <td>{activation.deviceSerialNumber ?? "-"}</td>
                <td><StatusBadge status={activation.status} /></td>
                <td>{activation.appVersion ?? "-"}</td>
                <td>{formatDateTime(activation.activatedAt)}</td>
                <td>{formatDateTime(activation.lastSeenAt)}</td>
                {onDeleteActivation && <td className="row actions"><IconAction label="Delete activation" tone="danger" onClick={() => onDeleteActivation(activation)}><Trash2 size={14} /></IconAction></td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Notes({ value }: { value?: string | null }) {
  if (!value) return null;
  return (
    <section className="detail-section">
      <div className="detail-section-header">
        <div>
          <h3>Internal notes</h3>
          <p>Visible only in the admin portal.</p>
        </div>
      </div>
      <div className="detail-note">{value}</div>
    </section>
  );
}

function DetailSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="detail-section">
      <div className="detail-section-header">
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
      </div>
      <div className="detail-grid">{children}</div>
    </section>
  );
}

function Detail({ label, value, mono = false, wide = false, full = false }: { label: string; value: any; mono?: boolean; wide?: boolean; full?: boolean }) {
  const content = value == null || value === "" ? "-" : value;
  const className = ["detail-item", wide ? "wide" : "", full ? "full" : ""].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <span>{label}</span>
      <strong className={mono ? "code" : undefined}>{content}</strong>
    </div>
  );
}

function formatDate(value?: string | Date | null) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString();
}

function formatDateTime(value?: string | Date | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function yesNo(value?: boolean | null) {
  if (value == null) return "-";
  return value ? "Yes" : "No";
}

function effectiveEnterpriseConfigProfile(licenseKey: any) {
  return licenseKey?.tenant?.configProfile ?? licenseKey?.configProfile ?? null;
}
