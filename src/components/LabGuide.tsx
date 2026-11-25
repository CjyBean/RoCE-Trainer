import type { LabDefinition } from '../data/labs';

export function LabGuide({ lab, variantId, onVariant }: { lab: LabDefinition; variantId: string; onVariant: (id: string) => void }) {
  const current = lab.variants.find((variant) => variant.id === variantId) ?? lab.variants[0];
  return (
    <div className="lab-guide">
      <h2>{lab.title}</h2>
      <p>{lab.subtitle}</p>
      <div className="guide-variants">
        {lab.variants.map((variant) => (
          <button key={variant.id} className={variantId === variant.id ? 'active' : ''} onClick={() => onVariant(variant.id)}>
            {variant.label}
          </button>
        ))}
      </div>
      <div className="guide-variant-description">{current.description}</div>
      <section className="guide-section">
        <h3>授课步骤</h3>
        <ol>{lab.steps.map((item) => <li key={item}>{item}</li>)}</ol>
      </section>
      <section className="guide-section">
        <h3>观察要点</h3>
        <ul>{lab.observations.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>
      <div className="guide-tip">切换问题/修复场景后点击“运行实验”，拓扑与业务保持不变，便于单变量对照。</div>
    </div>
  );
}
