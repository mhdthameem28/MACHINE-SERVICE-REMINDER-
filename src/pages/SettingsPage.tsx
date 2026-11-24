import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ALL_ROLES, ROLE_LABELS, UserRole } from '../lib/roles';
import { formatDateTime } from '../lib/format';
import {
  MaterialSettingItem,
  MaterialsSettingsPanel,
} from '../components/MaterialsSettingsPanel';
import {
  PartSettingItem,
  PartsSettingsPanel,
} from '../components/PartsSettingsPanel';

type SettingsTab =
  | 'stages'
  | 'materials'
  | 'parts'
  | 'users'
  | 'recipients'
  | 'audit'
  | 'danger';

interface DangerZoneSummary {
  transactional: {
    batches: number;
    batchStageHistory: number;
    stockMovements: number;
    partStockMovements: number;
    scrapLogs: number;
  };
  preserved: {
    materials: number;
    parts: number;
    users: number;
  };
}

interface StageItem {
  id: number;
  name: string;
  sequence: number;
  active: boolean;
}

interface UserItem {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  hasPassword: boolean;
  createdAt: string;
}

interface RecipientItem {
  id: number;
  email: string;
  name: string | null;
  active: boolean;
}

interface AuditEntry {
  id: number;
  userName: string;
  userEmail: string;
  action: string;
  entity: string;
  entityId: string;
  details: string | null;
  timestamp: string;
}

export const SettingsPage: React.FC = () => {
  const { user: currentUser, apiFetch } = useAuth();
  const [tab, setTab] = useState<SettingsTab>('stages');
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Stages state
  const [stages, setStages] = useState<StageItem[]>([]);
  const [newStageName, setNewStageName] = useState('');
  const [editingStageId, setEditingStageId] = useState<number | null>(null);
  const [editingStageName, setEditingStageName] = useState('');

  // Materials state
  const [materials, setMaterials] = useState<MaterialSettingItem[]>([]);

  // Parts Master state
  const [parts, setParts] = useState<PartSettingItem[]>([]);

  // Users state
  const [users, setUsers] = useState<UserItem[]>([]);
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userRole, setUserRole] = useState<UserRole>('operator');
  const [userPassword, setUserPassword] = useState('');
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [editUserRole, setEditUserRole] = useState<UserRole>('operator');
  const [editUserPassword, setEditUserPassword] = useState('');

  // Email recipients state
  const [recipients, setRecipients] = useState<RecipientItem[]>([]);
  const [recEmail, setRecEmail] = useState('');
  const [recName, setRecName] = useState('');

  // Audit log state
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);

  // Danger Zone state
  const [dangerSummary, setDangerSummary] = useState<DangerZoneSummary | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearingData, setClearingData] = useState(false);

  const showNotice = (msg: string) => {
    setFeedback(msg);
    setError(null);
  };

  const loadTab = async (target: SettingsTab) => {
    setError(null);
    try {
      if (target === 'stages') {
        const res = await apiFetch<{ stages: StageItem[] }>('/api/stages');
        setStages(res.stages);
      } else if (target === 'materials') {
        const res = await apiFetch<{ materials: MaterialSettingItem[] }>(
          '/api/materials?includeInactive=true'
        );
        setMaterials(res.materials);
      } else if (target === 'parts') {
        const res = await apiFetch<{ parts: PartSettingItem[] }>(
          '/api/parts?includeInactive=true'
        );
        setParts(res.parts);
      } else if (target === 'users') {
        const res = await apiFetch<{ users: UserItem[] }>('/api/settings/users');
        setUsers(res.users);
      } else if (target === 'recipients') {
        const res = await apiFetch<{ recipients: RecipientItem[] }>(
          '/api/settings/email-recipients'
        );
        setRecipients(res.recipients);
      } else if (target === 'audit') {
        const res = await apiFetch<{ entries: AuditEntry[] }>('/api/settings/audit-log');
        setAuditEntries(res.entries);
      } else if (target === 'danger') {
        const res = await apiFetch<DangerZoneSummary>('/api/settings/danger-zone/summary');
        setDangerSummary(res);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    }
  };

  useEffect(() => {
    loadTab(tab);
  }, [tab]);

  // Stages Handlers
  const handleAddStage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStageName.trim()) return;
    try {
      await apiFetch('/api/settings/stages', {
        method: 'POST',
        body: JSON.stringify({ name: newStageName.trim() }),
      });
      setNewStageName('');
      showNotice('Production stage added.');
      await loadTab('stages');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add stage');
    }
  };

  const handleSaveStageName = async (id: number) => {
    if (!editingStageName.trim()) return;
    try {
      await apiFetch(`/api/settings/stages/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editingStageName.trim() }),
      });
      setEditingStageId(null);
      showNotice('Stage updated.');
      await loadTab('stages');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update stage');
    }
  };

  const handleToggleStage = async (st: StageItem) => {
    try {
      await apiFetch(`/api/settings/stages/${st.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !st.active }),
      });
      showNotice(`Stage ${st.active ? 'deactivated' : 'activated'}.`);
      await loadTab('stages');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update stage status');
    }
  };

  const handleMoveStage = async (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= stages.length) return;
    const copy = [...stages];
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    try {
      const res = await apiFetch<{ stages: StageItem[] }>('/api/settings/stages/reorder', {
        method: 'POST',
        body: JSON.stringify({ orderedIds: copy.map((s) => s.id) }),
      });
      setStages(res.stages);
      showNotice('Stage sequence updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reorder stages');
    }
  };

  // Users Handlers
  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/settings/users', {
        method: 'POST',
        body: JSON.stringify({
          name: userName.trim(),
          email: userEmail.trim(),
          role: userRole,
          password: userPassword || undefined,
        }),
      });
      setUserName('');
      setUserEmail('');
      setUserRole('operator');
      setUserPassword('');
      showNotice('User account created.');
      await loadTab('users');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    }
  };

  const handleSaveUser = async (id: number) => {
    try {
      await apiFetch(`/api/settings/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          role: editUserRole,
          password: editUserPassword || undefined,
        }),
      });
      setEditingUserId(null);
      setEditUserPassword('');
      showNotice('User updated.');
      await loadTab('users');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    }
  };

  const handleToggleUser = async (u: UserItem) => {
    try {
      await apiFetch(`/api/settings/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !u.active }),
      });
      showNotice(
        u.active
          ? `Revoked access for ${u.email}.`
          : `Restored whitelist access for ${u.email}.`
      );
      await loadTab('users');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user status');
    }
  };

  const handleDeleteUser = async (u: UserItem) => {
    try {
      await apiFetch(`/api/settings/users/${u.id}`, { method: 'DELETE' });
      showNotice(`Removed ${u.email} from the authorized whitelist.`);
      await loadTab('users');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove user');
    }
  };

  // Recipients Handlers
  const handleAddRecipient = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/settings/email-recipients', {
        method: 'POST',
        body: JSON.stringify({
          email: recEmail.trim(),
          name: recName.trim() || undefined,
        }),
      });
      setRecEmail('');
      setRecName('');
      showNotice('Notification recipient added.');
      await loadTab('recipients');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add recipient');
    }
  };

  const handleToggleRecipient = async (r: RecipientItem) => {
    try {
      await apiFetch(`/api/settings/email-recipients/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !r.active }),
      });
      await loadTab('recipients');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update recipient');
    }
  };

  const handleDeleteRecipient = async (id: number) => {
    try {
      await apiFetch(`/api/settings/email-recipients/${id}`, { method: 'DELETE' });
      showNotice('Recipient removed.');
      await loadTab('recipients');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove recipient');
    }
  };

  // Danger Zone Handler
  const handleClearTransactionalData = async () => {
    setClearingData(true);
    try {
      const res = await apiFetch<{
        cleared: {
          batches: number;
          batchStageHistory: number;
          stockMovements: number;
          partStockMovements: number;
          scrapLogs: number;
          notifications: number;
        };
      }>('/api/settings/danger-zone/clear-transactional-data', {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      });
      setShowClearConfirm(false);
      const totalLedgers = res.cleared.stockMovements + res.cleared.partStockMovements;
      showNotice(
        `Cleared ${res.cleared.batches} batch(es), ${res.cleared.batchStageHistory} stage history record(s), ${totalLedgers} stock ledger movement(s), and ${res.cleared.scrapLogs} rejection(s). Users, Materials, and Parts Master were preserved.`
      );
      await loadTab('danger');
    } catch (err) {
      setShowClearConfirm(false);
      setError(err instanceof Error ? err.message : 'Failed to clear transactional data');
    } finally {
      setClearingData(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">System Administration</h1>
        <p className="text-sm text-slate-500 mt-1">
          Configure production stages, raw materials, user roles, alert recipients, and inspect the audit trail.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1 p-1 bg-white border border-slate-200 rounded-xl shadow-sm w-fit">
        {(
          [
            { id: 'stages', label: 'Production Stages' },
            { id: 'materials', label: 'Materials & Reorder Levels' },
            { id: 'parts', label: 'Parts Master (Cut Pieces)' },
            { id: 'users', label: 'Users & Whitelist' },
            { id: 'recipients', label: 'Email Recipients' },
            { id: 'audit', label: 'Audit Log' },
            { id: 'danger', label: 'Danger Zone' },
          ] as { id: SettingsTab; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              setFeedback(null);
              setError(null);
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              tab === t.id
                ? t.id === 'danger'
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'bg-indigo-600 text-white shadow-sm'
                : t.id === 'danger'
                ? 'text-red-600 hover:bg-red-50 hover:text-red-700'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {feedback && (
        <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center gap-2 text-xs font-medium text-emerald-900">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
          <span>{feedback}</span>
        </div>
      )}

      {error && (
        <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2 text-xs text-red-800">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* TAB 1: STAGES */}
      {tab === 'stages' && (
        <div className="space-y-5">
          <form
            onSubmit={handleAddStage}
            className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 flex flex-wrap items-end gap-3"
          >
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                New Stage Name
              </label>
              <input
                type="text"
                value={newStageName}
                onChange={(e) => setNewStageName(e.target.value)}
                placeholder="e.g., Powder Coating, Quality Inspection"
                required
                className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Stage</span>
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="px-4 py-3">Sequence</th>
                  <th className="px-4 py-3">Stage Name</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Order &amp; Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {stages.map((st, idx) => (
                  <tr
                    key={st.id}
                    className={`border-b border-slate-200 transition-colors ${
                      !st.active ? 'bg-slate-50/70 text-slate-400 hover:bg-slate-100' : 'hover:bg-slate-50'
                    }`}
                  >
                    <td className="px-4 py-3 text-xs tabular-nums">
                      {String(st.sequence).padStart(2, '0')}
                    </td>
                    <td className="px-4 py-3">
                      {editingStageId === st.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={editingStageName}
                            onChange={(e) => setEditingStageName(e.target.value)}
                            className="px-3 py-1.5 text-xs font-normal border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveStageName(st.id)}
                            className="px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingStageId(null)}
                            className="px-3 py-1.5 text-xs border border-slate-300 bg-white text-slate-700 rounded-lg hover:bg-slate-50"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <span className="font-medium text-slate-900">{st.name}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${
                          st.active
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                            : 'bg-slate-200/80 text-slate-700 border border-slate-300'
                        }`}
                      >
                        {st.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleMoveStage(idx, -1)}
                          disabled={idx === 0}
                          title="Move up"
                          className="p-1.5 border border-slate-300 bg-white rounded-lg hover:bg-slate-50 disabled:opacity-30"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveStage(idx, 1)}
                          disabled={idx === stages.length - 1}
                          title="Move down"
                          className="p-1.5 border border-slate-300 bg-white rounded-lg hover:bg-slate-50 disabled:opacity-30"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingStageId(st.id);
                            setEditingStageName(st.name);
                          }}
                          className="px-2.5 py-1 text-xs border border-slate-300 bg-white rounded-lg hover:bg-slate-50 text-slate-700"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleStage(st)}
                          className="px-2.5 py-1 text-xs border border-slate-300 bg-white rounded-lg hover:bg-slate-50 text-slate-700"
                        >
                          {st.active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: MATERIALS */}
      {tab === 'materials' && (
        <MaterialsSettingsPanel
          materials={materials}
          onRefresh={() => loadTab('materials')}
          onNotice={showNotice}
          onError={setError}
        />
      )}

      {/* TAB 3: PARTS MASTER */}
      {tab === 'parts' && (
        <PartsSettingsPanel
          parts={parts}
          onRefresh={() => loadTab('parts')}
          onNotice={showNotice}
          onError={setError}
        />
      )}

      {/* TAB 3: USERS & EMAIL WHITELIST */}
      {tab === 'users' && (
        <div className="space-y-5">
          <div className="bg-indigo-50/70 border border-indigo-200 rounded-xl px-4 py-3 text-xs text-slate-700 flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-semibold text-slate-900">Google OAuth &amp; Login Whitelist:</span>{' '}
              Only active email addresses listed below are permitted to sign in. Unauthorized emails are blocked with{' '}
              <span className="font-medium text-red-700">Access Denied: Unauthorized Email</span>.
            </div>
          </div>

          <form
            onSubmit={handleAddUser}
            className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end"
          >
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Full Name</label>
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Jane Doe"
                required
                className="w-full px-3.5 py-2 text-xs font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Authorized Email
              </label>
              <input
                type="email"
                value={userEmail}
                onChange={(e) => setUserEmail(e.target.value)}
                placeholder="operator@gmail.com"
                required
                className="w-full px-3.5 py-2 text-xs font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Role</label>
              <select
                value={userRole}
                onChange={(e) => setUserRole(e.target.value as UserRole)}
                className="w-full px-3.5 py-2 text-xs font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Password (optional for Google SSO)
              </label>
              <input
                type="password"
                value={userPassword}
                onChange={(e) => setUserPassword(e.target.value)}
                placeholder="Leave blank for Google SSO"
                minLength={userPassword ? 8 : undefined}
                className="w-full px-3.5 py-2 text-xs font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm whitespace-nowrap inline-flex items-center justify-center gap-1.5 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Whitelist User</span>
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="px-4 py-3">User ID</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Login Method</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Whitelist Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {users.map((u) => {
                  const isFallbackAdmin = u.email.toLowerCase() === 'admin@protrack.com';
                  return (
                    <tr
                      key={u.id}
                      className={`border-b border-slate-200 transition-colors ${
                        !u.active ? 'bg-slate-50 text-slate-400 hover:bg-slate-100' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="px-4 py-3 text-xs tabular-nums">#{u.id}</td>
                      <td className="px-4 py-3 font-medium text-slate-900">{u.name}</td>
                      <td className="px-4 py-3 text-xs text-slate-700">{u.email}</td>
                      <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">
                        {isFallbackAdmin
                          ? 'Email / Password'
                          : u.hasPassword
                          ? 'Google SSO & Password'
                          : 'Google SSO'}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {editingUserId === u.id ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <select
                              value={editUserRole}
                              onChange={(e) => setEditUserRole(e.target.value as UserRole)}
                              className="px-2.5 py-1.5 text-xs font-normal border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                            >
                              {ALL_ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {ROLE_LABELS[r]}
                                </option>
                              ))}
                            </select>
                            <input
                              type="password"
                              value={editUserPassword}
                              onChange={(e) => setEditUserPassword(e.target.value)}
                              placeholder="New password (optional)"
                              className="px-2.5 py-1.5 text-xs font-normal border border-slate-300 rounded-lg text-slate-900 w-36 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                            />
                          </div>
                        ) : (
                          <span className="font-medium text-slate-800">{ROLE_LABELS[u.role]}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${
                            u.active
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                              : 'bg-slate-200/80 text-slate-700 border border-slate-300'
                          }`}
                        >
                          {u.active ? 'Whitelisted' : 'Blocked'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {editingUserId === u.id ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleSaveUser(u.id)}
                              className="px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingUserId(null);
                                setEditUserPassword('');
                              }}
                              className="px-3 py-1.5 text-xs border border-slate-300 bg-white text-slate-700 rounded-lg hover:bg-slate-50"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingUserId(u.id);
                                setEditUserRole(u.role);
                                setEditUserPassword('');
                              }}
                              className="px-2.5 py-1 text-xs border border-slate-300 bg-white rounded-lg hover:bg-slate-50 text-slate-700"
                            >
                              Edit
                            </button>
                            {currentUser?.id !== u.id && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleToggleUser(u)}
                                  className="px-2.5 py-1 text-xs border border-slate-300 bg-white rounded-lg hover:bg-slate-50 text-slate-700"
                                >
                                  {u.active ? 'Deactivate' : 'Activate'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteUser(u)}
                                  title="Remove from whitelist"
                                  className="p-1.5 border border-slate-300 bg-white rounded-lg hover:bg-red-50 text-red-600"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: EMAIL RECIPIENTS */}
      {tab === 'recipients' && (
        <div className="space-y-5 max-w-3xl">
          <form
            onSubmit={handleAddRecipient}
            className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end"
          >
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Recipient Email
              </label>
              <input
                type="email"
                value={recEmail}
                onChange={(e) => setRecEmail(e.target.value)}
                placeholder="purchasing@company.com"
                required
                className="w-full px-3.5 py-2 text-xs font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Label / Name (optional)
              </label>
              <input
                type="text"
                value={recName}
                onChange={(e) => setRecName(e.target.value)}
                placeholder="Procurement Team"
                className="w-full px-3.5 py-2 text-xs font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm whitespace-nowrap transition-colors"
            >
              Add Recipient
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Label</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {recipients.map((r) => (
                  <tr key={r.id} className="border-b border-slate-200 hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 text-xs text-slate-900">{r.email}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">{r.name || '—'}</td>
                    <td className="px-4 py-3 text-xs">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${
                          r.active
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                            : 'bg-slate-200/80 text-slate-700 border border-slate-300'
                        }`}
                      >
                        {r.active ? 'Active' : 'Paused'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleToggleRecipient(r)}
                          className="px-2.5 py-1 text-xs border border-slate-300 bg-white rounded-lg hover:bg-slate-50 text-slate-700"
                        >
                          {r.active ? 'Pause' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteRecipient(r.id)}
                          title="Remove recipient"
                          className="p-1.5 border border-slate-300 bg-white rounded-lg hover:bg-red-50 text-red-600"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: AUDIT LOG */}
      {tab === 'audit' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-x-auto">
          <div className="px-5 py-3.5 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900">
              Append-Only System Audit Log
            </h3>
          </div>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="px-4 py-3">Timestamp (UTC)</th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Entity</th>
                <th className="px-4 py-3">Entity ID</th>
                <th className="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {auditEntries.map((a) => (
                <tr key={a.id} className="border-b border-slate-200 hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3 tabular-nums text-slate-600 whitespace-nowrap">
                    {formatDateTime(a.timestamp)}
                  </td>
                  <td className="px-4 py-3 text-slate-900">
                    <div>{a.userName}</div>
                    <div className="text-slate-500">{a.userEmail}</div>
                  </td>
                  <td className="px-4 py-3 font-semibold text-slate-900">
                    {a.action}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{a.entity}</td>
                  <td className="px-4 py-3 text-slate-800">{a.entityId}</td>
                  <td className="px-4 py-3 text-slate-500 max-w-xs truncate">
                    {a.details || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 7: DANGER ZONE */}
      {tab === 'danger' && (
        <div className="space-y-5 max-w-4xl">
          <div className="bg-white border border-red-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 py-4 bg-red-50/70 border-b border-red-200 flex items-center gap-2.5">
              <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
              <div>
                <h3 className="text-sm font-semibold text-red-900">
                  Danger Zone — Reset Transactional Data
                </h3>
                <p className="text-xs text-red-700 mt-0.5">
                  Wipe test transactions before going live while keeping your master setup intact.
                </p>
              </div>
            </div>

            <div className="p-5 space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 bg-red-50/40 border border-red-200 rounded-xl space-y-2.5">
                  <div className="text-xs font-semibold text-red-900">
                    Records That Will Be Wiped
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-700">
                    <li className="flex items-center justify-between">
                      <span>All Batches</span>
                      <span className="font-semibold text-red-700 tabular-nums">
                        {dangerSummary ? dangerSummary.transactional.batches : '—'}
                      </span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>All Batch Stage History</span>
                      <span className="font-semibold text-red-700 tabular-nums">
                        {dangerSummary ? dangerSummary.transactional.batchStageHistory : '—'}
                      </span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>All Raw Material Stock Movements</span>
                      <span className="font-semibold text-red-700 tabular-nums">
                        {dangerSummary ? dangerSummary.transactional.stockMovements : '—'}
                      </span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>All Cut Pieces Stock Movements</span>
                      <span className="font-semibold text-red-700 tabular-nums">
                        {dangerSummary ? dangerSummary.transactional.partStockMovements : '—'}
                      </span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>All Rejections (Scrap Log)</span>
                      <span className="font-semibold text-red-700 tabular-nums">
                        {dangerSummary ? dangerSummary.transactional.scrapLogs : '—'}
                      </span>
                    </li>
                  </ul>
                </div>

                <div className="p-4 bg-emerald-50/40 border border-emerald-200 rounded-xl space-y-2.5">
                  <div className="text-xs font-semibold text-emerald-900 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-700" />
                    <span>Master Data Preserved</span>
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-700">
                    <li className="flex items-center justify-between">
                      <span>Users &amp; Whitelist</span>
                      <span className="font-semibold text-emerald-800 tabular-nums">
                        {dangerSummary ? dangerSummary.preserved.users : '—'}
                      </span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>Raw Materials Master</span>
                      <span className="font-semibold text-emerald-800 tabular-nums">
                        {dangerSummary ? dangerSummary.preserved.materials : '—'}
                      </span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>Parts Master (Cut Pieces)</span>
                      <span className="font-mono font-semibold text-emerald-800 tabular-nums">
                        {dangerSummary ? dangerSummary.preserved.parts : '—'}
                      </span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>Production Stages &amp; Email Recipients</span>
                      <span className="font-mono font-semibold text-emerald-800">Kept</span>
                    </li>
                  </ul>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-4">
                <div className="text-xs text-slate-600 max-w-xl">
                  Once cleared, stock balances for all Raw Materials and Cut Pieces reset to{' '}
                  <span className="font-mono font-semibold text-slate-900">0</span> so you can begin recording live production entries.
                </div>
                <button
                  type="button"
                  onClick={() => setShowClearConfirm(true)}
                  className="px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 shadow-sm inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear All Transactional Data</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Clear Transactional Data Confirmation Modal */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-red-50">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600" />
                <h3 className="text-base font-bold tracking-tight text-red-900">
                  Clear All Transactional Data
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                disabled={clearingData}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-white/70"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-3 text-xs text-slate-700">
              <p className="font-semibold text-slate-900 text-sm">
                Are you sure? This cannot be undone.
              </p>
              <p>
                This will permanently wipe all batches, stage transition history, raw material and cut-piece stock movement ledgers, and rejection logs.
              </p>
              <p className="text-slate-500">
                Your Users, Materials, and Parts Master setups will remain intact.
              </p>
            </div>

            <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                disabled={clearingData}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleClearTransactionalData}
                disabled={clearingData}
                className="px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 shadow-sm disabled:opacity-50"
              >
                {clearingData ? 'Clearing...' : 'Yes, Clear All Transactional Data'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
