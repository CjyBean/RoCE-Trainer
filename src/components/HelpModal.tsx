import { BookOpen, CircleAlert, Keyboard, X } from 'lucide-react';

export function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="help-modal">
        <div className="modal-header"><div><BookOpen size={18} /><span>RoCE Trainer 使用说明</span></div><button onClick={onClose}><X size={18} /></button></div>
        <div className="help-content">
          <section><h3>课堂使用路径</h3><ol>
            <li>在左侧选择实验，在中央选择对照变体，点击“运行实验”。</li>
            <li>拖动时间轴定位第一次 ECN，再观察 CNP、DCQCN 降速和 PFC 的先后顺序。</li>
            <li>点击链路查看该链路曲线；点击设备修改参数或进入 CE 风格 CLI。</li>
            <li>在“业务”页签调整固定 NFS 模板、读写方向、优先级和同步突发参数。</li>
          </ol></section>
          <section><h3>机制关系</h3><div className="mechanism-flow"><span>队列增长</span><i>→</i><span>ECN 标记</span><i>→</i><span>接收端 CNP</span><i>→</i><span>DCQCN 降速</span></div><p>PFC 是缓冲耗尽前的最后保护。健康网络不应长期依赖 PFC 调速；持续暂停通常意味着门限、收敛比或端侧控制存在问题。</p></section>
          <section className="help-warning"><h3><CircleAlert size={15} />模型边界</h3><p>这是教学级离散事件仿真，不是 Linux NFS/RDMA 协议栈，也不复现特定交换芯片。数值用于解释趋势和因果关系，不应作为采购、容量规划或真实设备验收依据。CLI 是 CE 风格教学子集，不保证覆盖真实设备全部语法。</p></section>
          <section><h3><Keyboard size={15} />快捷操作</h3><div className="shortcut-grid"><span>拖入设备</span><kbd>从左侧设备库拖拽</kbd><span>建立链路</span><kbd>连线按钮 → 两个节点</kbd><span>命令换行</span><kbd>Shift + Enter</kbd><span>删除所选</span><kbd>Delete / Backspace</kbd><span>播放 / 暂停</span><kbd>Space</kbd></div></section>
        </div>
        <div className="modal-footer">RoCE Trainer v0.1 · 中文无损网络教学实验室</div>
      </div>
    </div>
  );
}
