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
import { BulkImportMaterialsModal } from './BulkImportMaterialsModal';

export interface MaterialSettingItem {
  id: number;
  code: string;
  name: string;
  unit: string;
  reorderLevel: number;
  active: boolean;
  currentStock: number;
}

interface MaterialsSettingsPanelProps {
  materials: MaterialSettingItem[];
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

export const MaterialsSettingsPanel: React.FC<MaterialsSettingsPanelProps> = ({
  materials,
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
  const [newUnit, setNewUnit] = useState('kg');
  const [newReorderLevel, setNewReorderLevel] = useState('25');
  const [savingNew, setSavingNew] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editUnit, setEditUnit] = useState('kg');
  const [editReorderLevel, setEditReorderLevel] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<MaterialSettingItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filteredMaterials = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return materials;
    return materials.filter(
      (m) =>
        m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    );
  }, [materials, searchQuery]);

  const handleAddMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidMaterialUnit(newUnit)) {
      onError(`Please select a valid unit (${MATERIAL_UNITS.join(', ')}).`);
      return;
    }
    setSavingNew(true);
    try {
      await apiFetch('/api/settings/materials', {
        method: 'POST',
        body: JSON.stringify({
          code: newCode.trim(),
          name: newName.trim(),
          unit: newUnit,
          reorderLevel: Number(newReorderLevel),
        }),
      });
      setNewCode('');
      setNewName('');
      setNewUnit('kg');
      setNewReorderLevel('25');
      setShowAddModal(false);
      onNotice('Material added successfully.');
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create material.');
    } finally {
      setSavingNew(false);
    }
  };

  const handleSaveEdit = async (id: number) => {
    if (!isValidMaterialUnit(editUnit)) {
      onError(`Please select a valid unit (${MATERIAL_UNITS.join(', ')}).`);
      return;
    }
    try {
      await apiFetch(`/api/settings/materials/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim(),
          unit: editUnit,
          reorderLevel: Number(editReorderLevel),
        }),
      });
      setEditingId(null);
      onNotice('Material updated successfully.');
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update material.');
    }
  };

  const handleToggleActive = async (m: MaterialSettingItem) => {
    try {
      await apiFetch(`/api/settings/materials/${m.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !m.active }),
      });
      onNotice(`Material ${m.code} ${m.active ? 'deactivated' : 'activated'}.`);
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update material status.');
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/settings/materials/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      const deletedCode = deleteTarget.code;
      setDeleteTarget(null);
      onNotice(`Material ${deletedCode} deleted permanently.`);
      await onRefresh();
    } catch (err) {
      setDeleteTarget(null);
      onError(err instanceof Error ? err.message : 'Failed to delete material.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Action Bar Above Table */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-slate-200 rounded-2xl shadow-sm px-5 py-3.5">
        <div className="flex items-center gap-3 flex-1 min-w-[240px] max-w-md">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by Material Code or Name..."
              className="w-full pl-10 pr-3.5 py-2 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
            />
          </div>
          <span className="text-xs text-slate-500 font-mono tabular-nums whitespace-nowrap">
            {filteredMaterials.length} / {materials.length}
          </span>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowBulkModal(true)}
            className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Bulk Import</span>
          </button>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Material</span>
          </button>
        </div>
      </div>

      {/* Materials Enterprise Table */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table
            className="w-full table-fixed min-w-[960px]"
            style={{ borderCollapse: 'collapse' }}
          >
            <colgroup>
              <col style={{ width: '140px' }} />
              <col style={{ width: '280px' }} />
              <col style={{ width: '100px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '130px' }} />
            </colgroup>
            <thead>
              <tr className="bg-slate-50/90 border-b border-slate-200 text-xs font-semibold text-slate-700">
                <th className="px-4 py-3 text-left border-r border-slate-200">
                  Material Code
                </th>
                <th className="px-4 py-3 text-left border-r border-slate-200">
                  Material Name
                </th>
                <th className="px-4 py-3 text-left border-r border-slate-200">
                  Unit
                </th>
                <th className="px-4 py-3 text-right border-r border-slate-200">
                  Current Stock
                </th>
                <th className="px-4 py-3 text-right border-r border-slate-200">
                  Reorder Level
                </th>
                <th className="px-4 py-3 text-center border-r border-slate-200">
                  Status
                </th>
                <th className="px-4 py-3 text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredMaterials.length === 0 ? (
                <tr className="border-b border-slate-200">
                  <td
                    colSpan={7}
                    className="px-6 py-12 text-center text-xs text-slate-500"
                  >
                    {searchQuery.trim()
                      ? `No materials match "${searchQuery.trim()}".`
                      : 'No materials found. Click "Add Material" or "Bulk Import" above to add materials.'}
                  </td>
                </tr>
              ) : (
                filteredMaterials.map((m) => {
                  const cleanUnit = sanitizeDisplayUnit(m.unit);
                  const isEditing = editingId === m.id;
                  const isLowStock = m.active && m.currentStock <= m.reorderLevel;

                  return (
                    <tr
                      key={m.id}
                      className={`border-b border-slate-200 transition-colors ${
                        !m.active
                          ? 'bg-slate-100/70 text-slate-400 hover:bg-slate-100'
                          : 'odd:bg-white even:bg-slate-50/70 hover:bg-slate-100/80'
                      }`}
                    >
                      {/* Cell 1: Material Code */}
                      <td className="px-4 py-3 text-left border-r border-slate-200 font-mono text-xs font-semibold text-slate-900 truncate">
                        {m.code}
                      </td>

                      {/* Cell 2: Material Name */}
                      <td className="px-4 py-3 text-left border-r border-slate-200 text-sm text-slate-900">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs font-normal bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                          />
                        ) : (
                          <span className="block truncate" title={m.name}>
                            {m.name}
                          </span>
                        )}
                      </td>

                      {/* Cell 3: Unit */}
                      <td className="px-4 py-3 text-left border-r border-slate-200 font-mono text-xs text-slate-700">
                        {isEditing ? (
                          <select
                            value={editUnit}
                            onChange={(e) => setEditUnit(e.target.value)}
                            className="w-full px-2 py-1.5 text-xs font-normal bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                          >
                            {!isValidMaterialUnit(editUnit) && (
                              <option value={editUnit} disabled>
                                {editUnit} (legacy)
                              </option>
                            )}
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

                      {/* Cell 4: Current Stock (right-aligned, clean single number + unit) */}
                      <td
                        className={`px-4 py-3 text-right border-r border-slate-200 font-mono text-xs tabular-nums whitespace-nowrap font-semibold ${
                          isLowStock ? 'text-red-700' : 'text-slate-900'
                        }`}
                      >
                        {formatWithUnit(m.currentStock, cleanUnit)}
                      </td>

                      {/* Cell 5: Reorder Level (right-aligned, clean single number + unit) */}
                      <td className="px-4 py-3 text-right border-r border-slate-200 font-mono text-xs tabular-nums whitespace-nowrap text-slate-700">
                        {isEditing ? (
                          <input
                            type="number"
                            step="any"
                            min="0"
                            value={editReorderLevel}
                            onChange={(e) => setEditReorderLevel(e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs font-normal bg-white border border-slate-300 rounded-lg text-right text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                          />
                        ) : (
                          formatWithUnit(m.reorderLevel, cleanUnit)
                        )}
                      </td>

                      {/* Cell 6: Status Pill Badge (center-aligned) */}
                      <td className="px-4 py-3 text-center border-r border-slate-200">
                        <span
                          className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${
                            m.active
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                              : 'bg-slate-200/80 text-slate-700 border border-slate-300'
                          }`}
                        >
                          {m.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>

                      {/* Cell 7: Compact Actions */}
                      <td className="px-4 py-3 text-center">
                        {isEditing ? (
                          <div className="inline-flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleSaveEdit(m.id)}
                              title="Save changes"
                              aria-label="Save changes"
                              className="p-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              title="Cancel edit"
                              aria-label="Cancel edit"
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
                                setEditingId(m.id);
                                setEditName(m.name);
                                setEditUnit(
                                  isValidMaterialUnit(m.unit)
                                    ? m.unit
                                    : isValidMaterialUnit(cleanUnit)
                                    ? cleanUnit
                                    : m.unit
                                );
                                setEditReorderLevel(String(m.reorderLevel));
                              }}
                              title="Edit material"
                              aria-label={`Edit ${m.code}`}
                              className="p-1.5 rounded border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleActive(m)}
                              title={m.active ? 'Deactivate material' : 'Activate material'}
                              aria-label={
                                m.active
                                  ? `Deactivate ${m.code}`
                                  : `Activate ${m.code}`
                              }
                              className={`p-1.5 rounded border bg-white transition-colors ${
                                m.active
                                  ? 'border-slate-300 text-slate-600 hover:text-red-700 hover:border-red-200 hover:bg-red-50'
                                  : 'border-slate-300 text-slate-600 hover:text-emerald-700 hover:border-emerald-200 hover:bg-emerald-50'
                              }`}
                            >
                              {m.active ? (
                                <Power className="w-3.5 h-3.5" />
                              ) : (
                                <RotateCcw className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(m)}
                              title="Delete material"
                              aria-label={`Delete ${m.code}`}
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

      {/* Add Material Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden shadow-xl">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-bold tracking-tight text-slate-900">Add New Material</h3>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAddMaterial} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Material Code
                </label>
                <input
                  type="text"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  placeholder="MAT-CU110"
                  required
                  className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Material Name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Copper Busbar C110"
                  required
                  className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">
                    Unit
                  </label>
                  <select
                    value={newUnit}
                    onChange={(e) => setNewUnit(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
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
                    className="w-full px-3.5 py-2.5 text-sm font-normal tabular-nums bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
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
                  {savingNew ? 'Saving...' : 'Create Material'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bulk Import Modal */}
      {showBulkModal && (
        <BulkImportMaterialsModal
          existingCodes={materials.map((m) => m.code)}
          onClose={() => setShowBulkModal(false)}
          onImported={async (summary) => {
            setShowBulkModal(false);
            const openingNote =
              summary.openingStockCount > 0
                ? ` and recorded ${summary.openingStockCount} Opening Stock ledger entr${
                    summary.openingStockCount === 1 ? 'y' : 'ies'
                  }`
                : '';
            const skippedNote =
              summary.skippedCodes.length > 0
                ? ` (${summary.skippedCodes.length} duplicate code(s) skipped)`
                : '';
            onNotice(
              `Imported ${summary.insertedCount} material${
                summary.insertedCount === 1 ? '' : 's'
              }${openingNote}${skippedNote}.`
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
                <h3 className="text-base font-bold tracking-tight text-slate-900">Delete Material</h3>
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
                Materials already tied to production batches or stock movement history cannot be deleted.
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
                {deleting ? 'Deleting...' : 'Delete Material'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
