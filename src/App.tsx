import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  CircleAlert,
  CloudUpload,
  Download,
  FlaskConical,
  Info,
  Loader2,
  Play,
  X,
} from 'lucide-react';
import { LabSidebar } from './components/LabSidebar';
import { TopologyCanvas } from './components/TopologyCanvas';
import { Timeline } from './components/Timeline';
import { MetricsPanel } from './components/MetricsPanel';
import { Inspector } from './components/Inspector';
import { HelpModal } from './components/HelpModal';
import { LABS, applyVariant, createDevice, createLink } from './data/labs';
import { useSimulation } from './hooks/useSimulation';
import { usePlayback } from './hooks/usePlayback';
import { validateConfig } from './sim/topology';
import type { NetworkConfig, NodeKind } from './sim/types';
import { downloadJson } from './utils/format';
import { parseValidNetworkConfig } from './utils/config';
import './styles.css';

const STORAGE_KEY = 'roce-trainer-config-v1';
const WORKSPACE_KEY = 'roce-trainer-workspace-v1';

function loadInitialWorkspace(): { config: NetworkConfig; activeLabId: string; variantId: string } {
  const fallback = { config: LABS[0].create(), activeLabId: LABS[0].id, variantId: LABS[0].variants[0].id };
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const workspace = JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? 'null') as { activeLabId?: string; variantId?: string } | null;
    const activeLab = LABS.find((lab) => lab.id === workspace?.activeLabId) ?? LABS[0];
    const activeLabId = activeLab.id;
    const variantId = activeLab.variants.some((variant) => variant.id === workspace?.variantId) ? workspace!.variantId! : activeLab.variants[0].id;
    if (saved) {
      const parsed = parseValidNetworkConfig(JSON.parse(saved));
      return { config: parsed, activeLabId, variantId };
    }
    return { config: activeLab.create(), activeLabId, variantId };
  } catch {
    // A broken local draft should never prevent the teaching labs from opening.
  }
  return fallback;
}

export default function App() {
  const [initialWorkspace] = useState(loadInitialWorkspace);
  const [config, setConfig] = useState<NetworkConfig>(initialWorkspace.config);
  const [activeLabId, setActiveLabId] = useState(initialWorkspace.activeLabId);
  const [variantId, setVariantId] = useState(initialWorkspace.variantId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [pendingLabId, setPendingLabId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialRunRef = useRef(false);
  const configRef = useRef(config);
  configRef.current = config;
  const activeLab = LABS.find((lab) => lab.id === activeLabId) ?? LABS[0];
  const { result, running, progress, error, run, cancel, clearError } = useSimulation();
  const playback = usePlayback(result);
  const issues = useMemo(() => validateConfig(config), [config]);
  const fatalIssues = issues.filter((issue) => issue.severity === 'error');
  const canExport = Boolean(result && !running && !dirty && !error);
  const simulationCompleted = (completedConfig: NetworkConfig) => {
    if (configRef.current === completedConfig) setDirty(false);
  };

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ activeLabId, variantId }));
    } catch { /* Storage quota is non-fatal. */ }
  }, [config, activeLabId, variantId]);

  useEffect(() => {
    if (initialRunRef.current) return;
    initialRunRef.current = true;
    if (!validateConfig(config).some((issue) => issue.severity === 'error')) {
      setDirty(true);
      run(config, simulationCompleted);
    }
  }, [config, run]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const changeConfig = (next: NetworkConfig) => {
    setConfig(next);
    setDirty(true);
    playback.setPlaying(false);
  };

  const startSimulation = (next = config) => {
    const errors = validateConfig(next).filter((issue) => issue.severity === 'error');
    if (errors.length) {
      setToast(`无法运行：${errors[0].message}`);
      return;
    }
    clearError();
    setDirty(true);
    run(next, simulationCompleted);
  };

  const selectLab = (id: string) => {
    if (id === activeLabId) return;
    if (dirty) setPendingLabId(id);
    else loadLab(id);
  };

  const loadLab = (id: string) => {
    const lab = LABS.find((item) => item.id === id);
    if (!lab) return;
    cancel();
    const next = lab.create();
    setActiveLabId(id);
    setVariantId(lab.variants[0].id);
    setSelectedId(null);
    setLinkSource(null);
    setLinkMode(false);
    setConfig(next);
    setPendingLabId(null);
    startSimulation(next);
  };

  const chooseVariant = (id: string) => {
    setVariantId(id);
    changeConfig(applyVariant(config, activeLab, id));
  };

  const addDevice = (kind: NodeKind, x?: number, y?: number) => {
    const isServer = kind === 'compute' || kind === 'storage';
    const count = config.nodes.filter((node) => isServer ? node.device === 'server' : node.device === 'switch').length;
    const limit = isServer ? 8 : 4;
    if (count >= limit) {
      setToast(`首版教学拓扑最多支持 ${limit} 台${isServer ? '服务器' : '交换机'}，可先删除现有设备。`);
      return;
    }
    const index = config.nodes.length;
    const node = createDevice(kind, x ?? 420 + (index % 3) * 70, y ?? 90 + (index % 4) * 90, config.nodes);
    changeConfig({ ...config, nodes: [...config.nodes, node] });
    setSelectedId(node.id);
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    if (config.nodes.some((node) => node.id === selectedId)) {
      changeConfig({
        ...config,
        nodes: config.nodes.filter((node) => node.id !== selectedId),
        links: config.links.filter((link) => link.source !== selectedId && link.target !== selectedId),
        flows: config.flows.filter((flow) => flow.source !== selectedId && flow.target !== selectedId),
      });
    } else {
      changeConfig({ ...config, links: config.links.filter((link) => link.id !== selectedId) });
    }
    setSelectedId(null);
    setLinkSource(null);
  };

  const handleLinkNode = (id: string) => {
    if (!linkSource) {
      setLinkSource(id);
      setSelectedId(id);
      return;
    }
    if (linkSource === id) {
      setLinkSource(null);
      return;
    }
    if (config.links.some((link) => (link.source === linkSource && link.target === id) || (link.source === id && link.target === linkSource))) {
      setToast('这两个设备之间已经存在链路。');
      setLinkSource(null);
      return;
    }
    const link = createLink(linkSource, id, config.links);
    changeConfig({ ...config, links: [...config.links, link] });
    setSelectedId(link.id);
    setLinkSource(null);
  };

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest?.('input, textarea, select, button, a, summary, [role="button"], [contenteditable="true"]') || target.isContentEditable) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) deleteSelected();
      if (event.code === 'Space' && result && !running) {
        event.preventDefault();
        playback.setPlaying((value) => !value);
      }
      if (event.key === 'Escape') {
        setLinkSource(null);
        setLinkMode(false);
        setSelectedId(null);
        setShowHelp(false);
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });

  const importConfig = async (file: File) => {
    try {
      const parsed = parseValidNetworkConfig(JSON.parse(await file.text()));
      cancel();
      setConfig(parsed);
      setSelectedId(null);
      startSimulation(parsed);
      setToast('拓扑与业务配置已导入。');
    } catch (reason) {
      setToast(`导入失败：${reason instanceof Error ? reason.message : '无法读取文件'}`);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand"><div className="brand-mark"><span>R</span><i /></div><div><strong>RoCE <b>Trainer</b></strong><small>无损网络教学实验室</small></div><span className="edition-badge">教学版</span></div>
        <div className="header-experiment">
          <FlaskConical size={15} />
          <span className="header-lab-index">{activeLab.index}</span>
          <div><strong>{activeLab.shortTitle}</strong><small>{activeLab.subtitle}</small></div>
          <div className="header-variant-select">
            <select value={variantId} onChange={(event) => chooseVariant(event.target.value)}>
              {activeLab.variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.label}</option>)}
            </select><ChevronDown size={13} />
          </div>
        </div>
        <div className="header-actions">
          <button className="header-button" onClick={() => fileInputRef.current?.click()} title="导入 JSON 配置"><CloudUpload size={15} /><span>导入</span></button>
          <button className="header-button" onClick={() => downloadJson('roce-trainer-topology.json', config)} title="导出拓扑与业务配置"><Download size={15} /><span>保存</span></button>
          <button className="header-button" onClick={() => setShowHelp(true)}><BookOpen size={15} /><span>指南</span></button>
          <button className="run-button" disabled={running} onClick={() => startSimulation()}>
            {running ? <Loader2 size={16} className="spin" /> : <Play size={16} fill="currentColor" />}
            <span>{running ? `计算中 ${Math.round(progress * 100)}%` : dirty ? '运行新配置' : '运行实验'}</span>
          </button>
        </div>
        {running && <div className="global-progress" style={{ width: `${progress * 100}%` }} />}
      </header>

      <main className="workspace">
        <LabSidebar labs={LABS} activeLab={activeLab} onSelectLab={selectLab} onAddDevice={addDevice} />
        <div className="center-workspace">
          <div className="canvas-wrap">
            <TopologyCanvas
              config={config}
              selectedId={selectedId}
              currentFrame={playback.currentFrame}
              traces={result?.traces ?? []}
              timeUs={playback.timeUs}
              playing={playback.playing}
              linkMode={linkMode}
              linkSource={linkSource}
              onSelect={setSelectedId}
              onNodeMove={(id, x, y) => changeConfig({ ...config, nodes: config.nodes.map((node) => node.id === id ? { ...node, x, y } : node) })}
              onAddDevice={addDevice}
              onToggleLinkMode={() => { setLinkMode((value) => !value); setLinkSource(null); }}
              onLinkNode={handleLinkNode}
              onDelete={deleteSelected}
            />
            {dirty && result && <div className="stale-result-badge">{running ? '正在计算新配置，当前显示上次结果' : '配置已修改，当前曲线来自上次运行'}</div>}
            {fatalIssues.length > 0 && <button className="validation-banner" onClick={() => setToast(fatalIssues[0].message)}><CircleAlert size={14} />{fatalIssues.length} 个拓扑问题待处理</button>}
          </div>
          <Timeline
            timeUs={playback.timeUs}
            durationUs={result?.summary.durationUs ?? config.settings.durationUs}
            events={result?.events ?? []}
            playing={playback.playing}
            speed={playback.speed}
            disabled={!result || running}
            onPlay={() => playback.setPlaying((value) => !value)}
            onSpeed={playback.setSpeed}
            onSeek={playback.seek}
            onStep={playback.step}
            onRestart={playback.restart}
          />
          <MetricsPanel
            result={result}
            currentFrame={playback.currentFrame}
            timeUs={playback.timeUs}
            selectedId={selectedId}
            onSeek={playback.seek}
            exportDisabled={!canExport}
            onExport={() => {
              if (!canExport) {
                setToast('请先运行当前配置，再导出一致的实验报告。');
                return;
              }
              downloadJson('roce-trainer-result.json', { exportedAt: new Date().toISOString(), disclaimer: '教学级仿真，不代表真实设备实测', config, result });
            }}
          />
        </div>
        <Inspector
          config={config}
          selectedId={selectedId}
          activeLab={activeLab}
          variantId={variantId}
          result={result}
          onChange={changeConfig}
          onVariant={chooseVariant}
        />
      </main>

      {toast && <div className="app-toast"><Info size={15} /><span>{toast}</span><button onClick={() => setToast(null)}><X size={14} /></button></div>}
      {error && <div className="app-toast error"><CircleAlert size={15} /><span>{error}</span><button onClick={clearError}><X size={14} /></button></div>}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {pendingLabId && (
        <div className="modal-backdrop"><div className="confirm-modal"><FlaskConical size={24} /><h3>载入新的实验模板？</h3><p>当前尚未运行的配置修改会被模板替换。已导出的文件不受影响。</p><div><button onClick={() => setPendingLabId(null)}>取消</button><button className="primary" onClick={() => loadLab(pendingLabId)}>载入并运行</button></div></div></div>
      )}
      <input ref={fileInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) importConfig(file); event.target.value = ''; }} />
    </div>
  );
}
