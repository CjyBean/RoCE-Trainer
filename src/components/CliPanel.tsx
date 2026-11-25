import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, TerminalSquare, Trash2 } from 'lucide-react';
import { executeCommand } from '../cli/parser';
import type { NetworkConfig, NetworkNode, SimulationResult } from '../sim/types';

interface CliPanelProps {
  config: NetworkConfig;
  node: NetworkNode;
  result: SimulationResult | null;
  onChange: (config: NetworkConfig) => void;
}

export function CliPanel({ config, node, result, onChange }: CliPanelProps) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([
    'RoCE Trainer CE 风格教学 CLI',
    '输入 help 查看本版本支持的命令。此处的配置会同步到图形面板。',
  ]);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHistory((current) => [...current.slice(-3), `— 已连接到 ${node.name} (${node.id}) —`]);
  }, [node.id, node.name]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [history]);

  const run = () => {
    const command = input.trim();
    if (!command) return;
    const response = executeCommand(config, node.id, command, result ?? undefined);
    setHistory((current) => [...current, `${node.name}> ${command}`, response.output].slice(-120));
    if (JSON.stringify(response.config) !== JSON.stringify(config)) onChange(response.config);
    setInput('');
  };

  return (
    <div className="cli-panel">
      <div className="cli-notice"><TerminalSquare size={14} /><span>CE 风格教学子集</span><i>配置双向同步</i></div>
      <div className="cli-output" ref={outputRef}>
        {history.map((line, index) => <pre key={index} className={line.includes('错误') || line.includes('Error') ? 'cli-error' : ''}>{line}</pre>)}
      </div>
      <div className="cli-suggestions">
        {['help', 'display dcb', 'display current-configuration', 'display qos queue statistics'].map((command) => (
          <button key={command} onClick={() => setInput(command)}>{command}</button>
        ))}
      </div>
      <div className="cli-input-row">
        <span>{node.name}&gt;</span>
        <textarea
          value={input}
          rows={2}
          spellCheck={false}
          placeholder="输入命令，Enter 执行；Shift+Enter 换行"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              run();
            }
          }}
        />
        <button title="执行命令" onClick={run}><CornerDownLeft size={16} /></button>
      </div>
      <button className="cli-clear" onClick={() => setHistory([])}><Trash2 size={12} />清屏</button>
    </div>
  );
}
