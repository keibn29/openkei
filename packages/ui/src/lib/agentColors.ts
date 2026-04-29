const AGENT_COLOR_PALETTE = [
  { var: '--status-success', class: 'agent-success' },
  { var: '--syntax-keyword', class: 'agent-keyword' },
  { var: '--syntax-type', class: 'agent-type' },
  { var: '--syntax-function', class: 'agent-function' },
  { var: '--syntax-number', class: 'agent-number' },
  { var: '--status-info', class: 'agent-info' },
  { var: '--status-warning', class: 'agent-warning' },
  { var: '--syntax-variable', class: 'agent-variable' },
];

const NAMED_AGENT_COLOR_VARS: Record<string, string> = {
  primary: '--primary',
  secondary: '--secondary-foreground',
  accent: '--primary-emphasis',
  success: '--status-success',
  warning: '--status-warning',
  error: '--status-error',
  info: '--status-info',
};

type AgentColor = {
  var: string;
  class: string;
};

type AgentColorOverride = AgentColor & {
  value: string;
  fallbackVar: string;
};

type RegisteredAgentColor = AgentColor & {
  fallbackVar: string;
};

const agentColorOverrides = new Map<string, AgentColorOverride>();
const registeredAgentColors = new Map<string, RegisteredAgentColor>();
let appliedOverrideVars = new Set<string>();

const hashAgentName = (agentName: string): string => {
  let hash = 0;
  for (let i = 0; i < agentName.length; i++) {
    const char = agentName.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
};

const normalizeAgentColor = (color: unknown): string | null => {
  if (typeof color !== 'string') {
    return null;
  }

  const trimmed = color.trim();
  if (!trimmed) {
    return null;
  }

  const namedVar = NAMED_AGENT_COLOR_VARS[trimmed.toLowerCase()];
  if (namedVar) {
    return `var(${namedVar})`;
  }

  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)) {
    return trimmed;
  }

  return null;
};

const applyAgentColorOverrideStyles = () => {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  appliedOverrideVars.forEach((varName) => root.style.removeProperty(varName));

  const nextVars = new Set<string>();
  const rules: string[] = [];

  registeredAgentColors.forEach((registered, agentName) => {
    const override = agentColorOverrides.get(agentName);
    if (override) {
      root.style.setProperty(override.var, override.value);
      nextVars.add(override.var);
    }

    rules.push(
      `.${registered.class}{--agent-color:var(${registered.var},var(${registered.fallbackVar}));--agent-color-bg:var(${registered.var},var(${registered.fallbackVar}));}`,
    );
  });

  appliedOverrideVars = nextVars;

  let style = document.getElementById('openchamber-agent-color-overrides') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'openchamber-agent-color-overrides';
    document.head.appendChild(style);
  }
  style.textContent = rules.join('\n');
};

const getFallbackAgentColor = (agentName: string): AgentColor => {
  if (agentName === 'build') {
    return AGENT_COLOR_PALETTE[0];
  }

  let hash = 0;
  for (let i = 0; i < agentName.length; i++) {
    const char = agentName.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  const paletteIndex = 1 + (Math.abs(hash) % (AGENT_COLOR_PALETTE.length - 1));
  return AGENT_COLOR_PALETTE[paletteIndex];
};

const registerAgentColor = (agentName: string): RegisteredAgentColor => {
  const existing = registeredAgentColors.get(agentName);
  if (existing) {
    return existing;
  }

  const fallback = getFallbackAgentColor(agentName);
  const key = hashAgentName(agentName);
  const registered: RegisteredAgentColor = {
    var: `--openchamber-agent-color-${key}`,
    class: `agent-custom-${key}`,
    fallbackVar: fallback.var,
  };

  registeredAgentColors.set(agentName, registered);
  applyAgentColorOverrideStyles();
  return registered;
};

export function setAgentColorOverrides(agents: Array<{ name?: string; color?: unknown }>) {
  agentColorOverrides.clear();

  agents.forEach((agent) => {
    if (typeof agent.name !== 'string' || agent.name.trim().length === 0) {
      return;
    }

    // Always register a deterministic fallback so agents without an explicit
    // OpenCode color still render with a stable pseudo-random color across
    // all sessions.
    const registered = registerAgentColor(agent.name);

    const value = normalizeAgentColor(agent.color);
    if (!value) {
      return;
    }

    agentColorOverrides.set(agent.name, {
      ...registered,
      value,
    });
  });

  applyAgentColorOverrideStyles();
}

export function getAgentColor(agentName: string | undefined): AgentColor {

  if (!agentName) {
    return AGENT_COLOR_PALETTE[0];
  }

  const registered = registerAgentColor(agentName);
  return {
    var: `${registered.var}, var(${registered.fallbackVar})`,
    class: registered.class,
  };
}

export function getAgentColorPalette() {
  return AGENT_COLOR_PALETTE;
}
