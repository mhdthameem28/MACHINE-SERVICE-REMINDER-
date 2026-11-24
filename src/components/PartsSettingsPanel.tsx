import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatWithUnit, sanitizeDisplayUnit } from '../lib/format';
import { isValidMaterialUnit, MATERIAL_UNITS } from '../lib/units';
import { BulkImportPartsModal } from './BulkImportPartsModal';

export interface PartSettingItem {
  id: number;
  code: string;
  name: string;
  unit: string;
  reorderLevel: number;
  active: boolean;
  currentStock: number;
}

interface PartsSettingsPanelProps {
  parts: PartSettingItem[];
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

export const PartsSettingsPanel: React.FC<PartsSettingsPanelProps> = ({
  parts,
  onRefresh,
  onNotice,
  onError,
}) => {
  const { apiFetch } = useAuth();

  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);

  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newUnit, setNewUnit] = useState('qty');
  const [newReorderLevel, setNewReorderLevel] = useState('15');
  const [newOpeningQty, setNewOpeningQty] = useState('0');
  const [savingNew, setSavingNew] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editUnit, setEditUnit] = useState('qty');
  const [editReorderLevel, setEditReorderLevel] = useState('0');

  const [deleteTarget, setDeleteTarget] = useState<PartSettingItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filteredParts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return parts;
    return parts.filter(
      (p) => p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    );
  }, [parts, searchQuery]);

  const handleAddPart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidMaterialUnit(newUnit)) {
      onError(`Please select a valid unit (${MATERIAL_UNITS.join(', ')}).`);
      return;
    }
    const reorderNum = Number(newReorderLevel || 0);
    if (!Number.isFinite(reorderNum) || reorderNum < 0) {
      onError('Reorder Level must be zero or greater.');
      return;
    }
    const qtyNum = Number(newOpeningQty || 0);
    if (!Number.isFinite(qtyNum) || qtyNum < 0) {
      onError('Opening Qty must be zero or greater.');
      return;
    }

    setSavingNew(true);
    try {
      await apiFetch('/api/settings/parts', {
        method: 'POST',
        body: JSON.stringify({
          code: newCode.trim(),
          name: newName.trim(),
          unit: newUnit,
          reorderLevel: reorderNum,
          qty: qtyNum,
        }),
      });
      setNewCode('');
      setNewName('');
      setNewUnit('qty');
      setNewReorderLevel('15');
      setNewOpeningQty('0');
      setShowAddModal(false);
      onNotice('Cut part added to Parts Master.');
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create part.');
    } finally {
      setSavingNew(false);
    }
  };

  const handleSaveEdit = async (id: number) => {
    if (!isValidMaterialUnit(editUnit)) {
      onError(`Please select a valid unit (${MATERIAL_UNITS.join(', ')}).`);
      return;
    }
    const reorderNum = Number(editReorderLevel || 0);
    if (!Number.isFinite(reorderNum) || reorderNum < 0) {
      onError('Reorder Level must be zero or greater.');
      return;
    }
    try {
      await apiFetch(`/api/settings/parts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim(),
          unit: editUnit,
          reorderLevel: reorderNum,
        }),
      });
      setEditingId(null);
      onNotice('Part updated successfully.');
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update part.');
    }
  };

  const handleToggleActive = async (p: PartSettingItem) => {
    try {
      await apiFetch(`/api/settings/parts/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !p.active }),
      });
      onNotice(`Part ${p.code} ${p.active ? 'deactivated' : 'activated'}.`);
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update part status.');
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/settings/parts/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      const deletedCode = deleteTarget.code;
      setDeleteTarget(null);
      onNotice(`Cut part ${deletedCode} deleted permanently.`);
      await onRefresh();
    } catch (err) {
      setDeleteTarget(null);
      onError(err instanceof Error ? err.message : 'Failed to delete part.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-slate-200 rounded-2xl shadow-sm px-5 py-3.5">
        <div className="flex items-center gap-3 flex-1 min-w-[240px] max-w-md">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by Part Code or Part Name..."
              className="w-full pl-10 pr-3.5 py-2 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
            />
          </div>
          <span className="text-xs text-slate-500 font-mono tabular-nums whitespace-nowrap">
            {filteredParts.length} / {parts.length}
          </span>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowBulkModal(true)}
            className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Bulk Import Parts</span>
          </button>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Part</span>
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table
            className="w-full table-fixed min-w-[980px]"
            style={{ borderCollapse: 'collapse' }}
          >
            <colgroup>
              <col style={{ width: '150px' }} />
              <col style={{ width: '280px' }} />
              <col style={{ width: '90px' }} />
              <col style={{ width: '140px' }} />
              <col style={{ width: '140px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '130px' }} />
            </colgroup>
            <thead>
              <tr className="bg-slate-50/90 border-b border-slate-200 text-xs font-semibold text-slate-700">
                <th className="px-4 py-3 text-left border-r border-slate-200">Part Code</th>
                <th className="px-4 py-3 text-left border-r border-slate-200">Part Name</th>
                <th className="px-4 py-3 text-left border-r border-slate-200">Unit</th>
                <th className="px-4 py-3 text-right border-r border-slate-200">Current Stock</th>
                <th className="px-4 py-3 text-right border-r border-slate-200">Reorder Level</th>
                <th className="px-4 py-3 text-center border-r border-slate-200">Status</th>
                <th className="px-4 py-3 text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredParts.length === 0 ? (
                <tr className="border-b border-slate-200">
                  <td colSpan={7} className="px-6 py-12 text-center text-xs text-slate-500">
                    {searchQuery.trim()
                      ? `No parts match "${searchQuery.trim()}".`
                      : 'No cut parts found in Parts Master. Click "Add Part" or "Bulk Import Parts" above.'}
                  </td>
                </tr>
              ) : (
                filteredParts.map((p) => {
                  const cleanUnit = sanitizeDisplayUnit(p.unit);
                  const isEditing = editingId === p.id;
                  const isLowStock = p.active && p.currentStock <= p.reorderLevel;

                  return (
                    <tr
                      key={p.id}
                      className={`border-b border-slate-200 transition-colors ${
                        !p.active
                          ? 'bg-slate-100/70 text-slate-400 hover:bg-slate-100'
                          : 'odd:bg-white even:bg-slate-50/70 hover:bg-slate-100/80'
                      }`}
                    >
                      <td className="px-4 py-3 text-left border-r border-slate-200 font-mono text-xs font-semibold text-slate-900 truncate">
                        {p.code}
                      </td>
                      <td className="px-4 py-3 text-left border-r border-slate-200 text-sm text-slate-900">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs font-normal bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                          />
                        ) : (
                          <span className="block truncate" title={p.name}>
                            {p.name}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-left border-r border-slate-200 font-mono text-xs text-slate-700">
                        {isEditing ? (
                          <select
                            value={editUnit}
                            onChange={(e) => setEditUnit(e.target.value)}
                            className="w-full px-2 py-1.5 text-xs font-normal bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                          >
                            {MATERIAL_UNITS.map((u) => (
                              <option key={u} value={u}>
                                {u}
                              </option>
                            ))}
                          </select>
                        ) : (
                          cleanUnit
                        )}
                      </td>
                      <td
                        className={`px-4 py-3 text-right border-r border-slate-200 font-mono text-xs tabular-nums whitespace-nowrap font-semibold ${
                          isLowStock ? 'text-red-700' : 'text-slate-900'
                        }`}
                      >
                        {formatWithUnit(p.currentStock, cleanUnit)}
                      </td>
                      <td className="px-4 py-3 text-right border-r border-slate-200 font-mono text-xs tabular-nums whitespace-nowrap text-slate-700">
                        {isEditing ? (
                          <input
                            type="number"
                            step="any"
                            min="0"
                            value={editReorderLevel}
                            onChange={(e) => setEditReorderLevel(e.target.value)}
                            className="w-24 ml-auto px-2.5 py-1.5 text-right text-xs font-normal tabular-nums bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                          />
                        ) : (
                          formatWithUnit(p.reorderLevel, cleanUnit)
                        )}
                      </td>
                      <td className="px-4 py-3 text-center border-r border-slate-200">
                        <span
                          className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${
                            p.active
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                              : 'bg-slate-200/80 text-slate-700 border border-slate-300'
                          }`}
                        >
                          {p.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {isEditing ? (
                          <div className="inline-flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleSaveEdit(p.id)}
                              title="Save changes"
                              className="p-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              title="Cancel edit"
                              className="p-1.5 rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(p.id);
                                setEditName(p.name);
                                setEditUnit(
                                  isValidMaterialUnit(p.unit) ? p.unit : 'qty'
                                );
                                setEditReorderLevel(String(p.reorderLevel ?? 0));
                              }}
                              title="Edit part"
                              className="p-1.5 rounded border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleActive(p)}
                              title={p.active ? 'Deactivate part' : 'Activate part'}
                              className={`p-1.5 rounded border bg-white transition-colors ${
                                p.active
                                  ? 'border-slate-300 text-slate-600 hover:text-red-700 hover:border-red-200 hover:bg-red-50'
                                  : 'border-slate-300 text-slate-600 hover:text-emerald-700 hover:border-emerald-200 hover:bg-emerald-50'
                              }`}
                            >
                              {p.active ? (
                                <Power className="w-3.5 h-3.5" />
                              ) : (
                                <RotateCcw className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(p)}
                              title="Delete part"
                              aria-label={`Delete ${p.code}`}
                              className="p-1.5 rounded border border-slate-300 bg-white text-red-600 hover:bg-red-50 hover:border-red-200 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Single Part Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden shadow-xl">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-bold tracking-tight text-slate-900">Add Cut Part</h3>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAddPart} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Part Code
                </label>
                <input
                  type="text"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  placeholder="PART-CLAV-L12"
                  required
                  className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Part Name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Clavicle Superior Lateral Plate Left 1-12 Hole"
                  required
                  className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">
                    Unit
                  </label>
                  <select
                    value={newUnit}
                    onChange={(e) => setNewUnit(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                  >
                    {MATERIAL_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">
                    Reorder Level
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={newReorderLevel}
                    onChange={(e) => setNewReorderLevel(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">
                    Qty (Opening Stock)
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={newOpeningQty}
                    onChange={(e) => setNewOpeningQty(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                  />
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingNew}
                  className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm disabled:opacity-50 transition-colors"
                >
                  {savingNew ? 'Saving...' : 'Create Part'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bulk Import Parts Modal */}
      {showBulkModal && (
        <BulkImportPartsModal
          existingCodes={parts.map((p) => p.code)}
          onClose={() => setShowBulkModal(false)}
          onImported={async (summary) => {
            setShowBulkModal(false);
            const openingNote =
              summary.openingStockCount > 0
                ? ` and recorded ${summary.openingStockCount} Opening Stock ledger entr${
                    summary.openingStockCount === 1 ? 'y' : 'ies'
                  }`
                : '';
            const alertNote =
              summary.reorderAlertCount > 0
                ? ` (${summary.reorderAlertCount} reorder alert${
                    summary.reorderAlertCount === 1 ? '' : 's'
                  } triggered)`
                : '';
            const skippedNote =
              summary.skippedCodes.length > 0
                ? ` (${summary.skippedCodes.length} duplicate code(s) skipped)`
                : '';
            onNotice(
              `Imported ${summary.insertedCount} part${
                summary.insertedCount === 1 ? '' : 's'
              }${openingNote}${alertNote}${skippedNote}.`
            );
            await onRefresh();
          }}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden shadow-xl">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600" />
                <h3 className="text-base font-bold tracking-tight text-slate-900">Delete Cut Part</h3>
              </div>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-xs text-slate-600">
              <p>
                Are you sure you want to permanently delete{' '}
                <span className="font-mono font-semibold text-slate-900">{deleteTarget.code}</span>{' '}
                (<span className="font-medium text-slate-900">{deleteTarget.name}</span>)?
              </p>
              <p className="text-slate-500">
                Cut parts already tied to production batches or stock movement history cannot be deleted.
              </p>
            </div>
            <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="px-4 py-2 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 shadow-sm disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete Part'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
