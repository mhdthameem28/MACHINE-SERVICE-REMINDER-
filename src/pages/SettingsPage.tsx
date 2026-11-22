import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Plus,
  Trash2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ALL_ROLES, ROLE_LABELS, UserRole } from '../lib/roles';
import { formatDateTime, formatWithUnit } from '../lib/format';

type SettingsTab = 'stages' | 'materials' | 'users' | 'recipients' | 'audit';

interface StageItem {
  id: number;
  name: string;
  sequence: number;
  active: boolean;
}

interface MaterialItem {
  id: number;
  code: string;
  name: string;
  unit: string;
  reorderLevel: number;
  active: boolean;
  currentStock: number;
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
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [matCode, setMatCode] = useState('');
  const [matName, setMatName] = useState('');
  const [matUnit, setMatUnit] = useState('kg');
  const [matReorder, setMatReorder] = useState('25');
  const [editingMatId, setEditingMatId] = useState<number | null>(null);
  const [editMatName, setEditMatName] = useState('');
  const [editMatUnit, setEditMatUnit] = useState('');
  const [editMatReorder, setEditMatReorder] = useState('');

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
        const res = await apiFetch<{ materials: MaterialItem[] }>(
          '/api/materials?includeInactive=true'
        );
        setMaterials(res.materials);
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

  // Materials Handlers
  const handleAddMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/settings/materials', {
        method: 'POST',
        body: JSON.stringify({
          code: matCode.trim(),
          name: matName.trim(),
          unit: matUnit.trim(),
          reorderLevel: Number(matReorder),
        }),
      });
      setMatCode('');
      setMatName('');
      setMatUnit('kg');
      setMatReorder('25');
      showNotice('Material added.');
      await loadTab('materials');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create material');
    }
  };

  const handleSaveMaterial = async (id: number) => {
    try {
      await apiFetch(`/api/settings/materials/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editMatName.trim(),
          unit: editMatUnit.trim(),
          reorderLevel: Number(editMatReorder),
        }),
      });
      setEditingMatId(null);
      showNotice('Material updated.');
      await loadTab('materials');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update material');
    }
  };

  const handleToggleMaterial = async (m: MaterialItem) => {
    try {
      await apiFetch(`/api/settings/materials/${m.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !m.active }),
      });
      showNotice(`Material ${m.active ? 'deactivated' : 'activated'}.`);
      await loadTab('materials');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update material');
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
      showNotice(`User ${u.active ? 'deactivated' : 'activated'}.`);
      await loadTab('users');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user status');
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">System Administration</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Configure production stages, raw materials, user roles, alert recipients, and inspect the audit trail.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {(
          [
            { id: 'stages', label: 'Production Stages' },
            { id: 'materials', label: 'Materials & Reorder Levels' },
            { id: 'users', label: 'Users & Roles' },
            { id: 'recipients', label: 'Email Recipients' },
            { id: 'audit', label: 'Audit Log' },
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
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === t.id
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {feedback && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2 text-xs font-medium text-emerald-900">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
          <span>{feedback}</span>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-xs text-red-800">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* TAB 1: STAGES */}
      {tab === 'stages' && (
        <div className="space-y-5">
          <form
            onSubmit={handleAddStage}
            className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-end gap-3"
          >
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                New Stage Name
              </label>
              <input
                type="text"
                value={newStageName}
                onChange={(e) => setNewStageName(e.target.value)}
                placeholder="e.g., Powder Coating, Quality Inspection"
                required
                className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900/15"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Stage</span>
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                  <th className="px-4 py-2.5">Sequence</th>
                  <th className="px-4 py-2.5">Stage Name</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Order &amp; Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {stages.map((st, idx) => (
                  <tr key={st.id} className={!st.active ? 'bg-slate-50/70 text-slate-400' : ''}>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums">
                      {String(st.sequence).padStart(2, '0')}
                    </td>
                    <td className="px-4 py-2.5">
                      {editingStageId === st.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={editingStageName}
                            onChange={(e) => setEditingStageName(e.target.value)}
                            className="px-2.5 py-1 text-xs border border-slate-300 rounded text-slate-900"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveStageName(st.id)}
                            className="px-2.5 py-1 text-xs font-medium bg-slate-900 text-white rounded"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingStageId(null)}
                            className="px-2 py-1 text-xs text-slate-600"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <span className="font-medium text-slate-900">{st.name}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      <span className={st.active ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                        {st.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleMoveStage(idx, -1)}
                          disabled={idx === 0}
                          title="Move up"
                          className="p-1.5 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-30"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveStage(idx, 1)}
                          disabled={idx === stages.length - 1}
                          title="Move down"
                          className="p-1.5 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-30"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingStageId(st.id);
                            setEditingStageName(st.name);
                          }}
                          className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 text-slate-700"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleStage(st)}
                          className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 text-slate-700"
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
        <div className="space-y-5">
          <form
            onSubmit={handleAddMaterial}
            className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end"
          >
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Code</label>
              <input
                type="text"
                value={matCode}
                onChange={(e) => setMatCode(e.target.value)}
                placeholder="MAT-CU110"
                required
                className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-md"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Material Name</label>
              <input
                type="text"
                value={matName}
                onChange={(e) => setMatName(e.target.value)}
                placeholder="Copper Busbar C110"
                required
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Unit</label>
              <input
                type="text"
                value={matUnit}
                onChange={(e) => setMatUnit(e.target.value)}
                placeholder="kg / sheets"
                required
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-700 mb-1">Reorder</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={matReorder}
                  onChange={(e) => setMatReorder(e.target.value)}
                  required
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-md"
                />
              </div>
              <button
                type="submit"
                className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap"
              >
                Add
              </button>
            </div>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                  <th className="px-4 py-2.5">Code</th>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Unit</th>
                  <th className="px-4 py-2.5 text-right">Current Stock</th>
                  <th className="px-4 py-2.5 text-right">Reorder Level</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {materials.map((m) => (
                  <tr key={m.id} className={!m.active ? 'bg-slate-50 text-slate-400' : ''}>
                    <td className="px-4 py-2.5 font-mono text-xs font-semibold text-slate-900">
                      {m.code}
                    </td>
                    <td className="px-4 py-2.5">
                      {editingMatId === m.id ? (
                        <input
                          type="text"
                          value={editMatName}
                          onChange={(e) => setEditMatName(e.target.value)}
                          className="px-2 py-1 text-xs border border-slate-300 rounded w-full text-slate-900"
                        />
                      ) : (
                        m.name
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {editingMatId === m.id ? (
                        <input
                          type="text"
                          value={editMatUnit}
                          onChange={(e) => setEditMatUnit(e.target.value)}
                          className="px-2 py-1 text-xs border border-slate-300 rounded w-20 text-slate-900"
                        />
                      ) : (
                        m.unit
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {formatWithUnit(m.currentStock, m.unit)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {editingMatId === m.id ? (
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={editMatReorder}
                          onChange={(e) => setEditMatReorder(e.target.value)}
                          className="px-2 py-1 text-xs border border-slate-300 rounded w-24 text-right text-slate-900"
                        />
                      ) : (
                        formatWithUnit(m.reorderLevel, m.unit)
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      <span className={m.active ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                        {m.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {editingMatId === m.id ? (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleSaveMaterial(m.id)}
                            className="px-2.5 py-1 text-xs font-medium bg-slate-900 text-white rounded"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingMatId(null)}
                            className="px-2 py-1 text-xs text-slate-600"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingMatId(m.id);
                              setEditMatName(m.name);
                              setEditMatUnit(m.unit);
                              setEditMatReorder(String(m.reorderLevel));
                            }}
                            className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 text-slate-700"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleMaterial(m)}
                            className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 text-slate-700"
                          >
                            {m.active ? 'Deactivate' : 'Activate'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: USERS */}
      {tab === 'users' && (
        <div className="space-y-5">
          <form
            onSubmit={handleAddUser}
            className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end"
          >
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Jane Doe"
                required
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={userEmail}
                onChange={(e) => setUserEmail(e.target.value)}
                placeholder="operator@company.com"
                required
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Role</label>
              <select
                value={userRole}
                onChange={(e) => setUserRole(e.target.value as UserRole)}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Password (optional for Google SSO)
              </label>
              <input
                type="password"
                value={userPassword}
                onChange={(e) => setUserPassword(e.target.value)}
                placeholder="Min 8 chars"
                minLength={userPassword ? 8 : undefined}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap"
            >
              Add User
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                  <th className="px-4 py-2.5">User ID</th>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Email</th>
                  <th className="px-4 py-2.5">Role</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {users.map((u) => (
                  <tr key={u.id} className={!u.active ? 'bg-slate-50 text-slate-400' : ''}>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums">#{u.id}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{u.name}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">{u.email}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {editingUserId === u.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={editUserRole}
                            onChange={(e) => setEditUserRole(e.target.value as UserRole)}
                            className="px-2 py-1 text-xs border border-slate-300 rounded text-slate-900"
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
                            className="px-2 py-1 text-xs border border-slate-300 rounded text-slate-900 w-36"
                          />
                        </div>
                      ) : (
                        <span className="font-medium text-slate-800">{ROLE_LABELS[u.role]}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      <span className={u.active ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                        {u.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {editingUserId === u.id ? (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleSaveUser(u.id)}
                            className="px-2.5 py-1 text-xs font-medium bg-slate-900 text-white rounded"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingUserId(null);
                              setEditUserPassword('');
                            }}
                            className="px-2 py-1 text-xs text-slate-600"
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
                            className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 text-slate-700"
                          >
                            Edit
                          </button>
                          {currentUser?.id !== u.id && (
                            <button
                              type="button"
                              onClick={() => handleToggleUser(u)}
                              className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 text-slate-700"
                            >
                              {u.active ? 'Deactivate' : 'Activate'}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
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
            className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end"
          >
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Recipient Email
              </label>
              <input
                type="email"
                value={recEmail}
                onChange={(e) => setRecEmail(e.target.value)}
                placeholder="purchasing@company.com"
                required
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Label / Name (optional)
              </label>
              <input
                type="text"
                value={recName}
                onChange={(e) => setRecName(e.target.value)}
                placeholder="Procurement Team"
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap"
            >
              Add Recipient
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                  <th className="px-4 py-2.5">Email</th>
                  <th className="px-4 py-2.5">Label</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {recipients.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-900">{r.email}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">{r.name || '—'}</td>
                    <td className="px-4 py-2.5 text-xs">
                      <span className={r.active ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                        {r.active ? 'Active' : 'Paused'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleToggleRecipient(r)}
                          className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 text-slate-700"
                        >
                          {r.active ? 'Pause' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteRecipient(r.id)}
                          title="Remove recipient"
                          className="p-1.5 border border-slate-200 rounded hover:bg-red-50 text-red-600"
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
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <div className="px-4 py-3 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900">
              Append-Only System Audit Log
            </h3>
          </div>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                <th className="px-4 py-2.5">Timestamp (UTC)</th>
                <th className="px-4 py-2.5">User</th>
                <th className="px-4 py-2.5">Action</th>
                <th className="px-4 py-2.5">Entity</th>
                <th className="px-4 py-2.5">Entity ID</th>
                <th className="px-4 py-2.5">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {auditEntries.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2.5 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                    {formatDateTime(a.timestamp)}
                  </td>
                  <td className="px-4 py-2.5 text-slate-900">
                    <div>{a.userName}</div>
                    <div className="text-slate-500">{a.userEmail}</div>
                  </td>
                  <td className="px-4 py-2.5 font-mono font-semibold text-slate-900">
                    {a.action}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-slate-600">{a.entity}</td>
                  <td className="px-4 py-2.5 font-mono text-slate-800">{a.entityId}</td>
                  <td className="px-4 py-2.5 font-mono text-slate-500 max-w-xs truncate">
                    {a.details || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
