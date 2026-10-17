import type { Config, SubagentRoleConfig } from "../../App.types";
import type { SubagentModelOption } from "../../subagentModels";

export const BUILTIN_SUBAGENT_ROLES = [
  { id: "codey_quick_scan", name: "快速定位", kind: "analysis", description: "用于精确位置、重复性检查、低风险事实查找和小范围快速检索。" },
  { id: "codey_deep_research", name: "深度检索", kind: "analysis", description: "用于跨文件、日志、代码和文档的宽范围检索、归纳与架构探索。" },
  { id: "codey_visual_analysis", name: "视觉分析", kind: "analysis", description: "用于截图、页面、GUI、PDF 或渲染结果的视觉证据分析。" },
  { id: "codey_worker", name: "代码实施", kind: "implementation", description: "用于边界清晰、可回滚、可测试的非视觉实现。" },
  { id: "codey_visual_worker", name: "视觉实施", kind: "implementation", description: "用于页面、GUI、PDF 或其他依赖视觉证据和渲染验证的实现。" },
] as const;

export function isCustomSubagent(id: string) {
  return id !== "default" && !BUILTIN_SUBAGENT_ROLES.some(role => role.id === id);
}

export function enabledSubagentCount(config: Config) {
  return Object.entries(config.subagentRoles).filter(([id, role]) => id !== "default" && role.enabled).length;
}

export function addCustomSubagent(config: Config, model?: SubagentModelOption): Config {
  if (Object.keys(config.subagentRoles).filter(isCustomSubagent).length >= 32) return config;
  let index = 1;
  while (Object.prototype.hasOwnProperty.call(config.subagentRoles, `custom_agent_${index}`)) index++;
  const id = `custom_agent_${index}`;
  const selection: SubagentRoleConfig = {
    enabled: true,
    name: `自定义子代理 ${index}`,
    description: "用于主代理明确指定的专项调查与核验。",
    developerInstructions: "根据主代理交付的目标进行调查，返回结论、证据与未完成项。",
    access: "readOnly",
    model: model?.value ?? config.subagentModel,
    reasoningEffort: model?.defaultReasoningEffort ?? config.subagentReasoningEffort,
  };
  return { ...config, subagentRoles: { ...config.subagentRoles, [id]: selection } };
}

export function updateSubagent(config: Config, id: string, patch: Partial<SubagentRoleConfig>): Config {
  const previous = config.subagentRoles[id];
  if (!previous || id === "default") return config;
  if (patch.enabled === false && previous.enabled && enabledSubagentCount(config) <= 1) return config;
  return { ...config, subagentRoles: { ...config.subagentRoles, [id]: { ...previous, ...patch } } };
}

export function removeCustomSubagent(config: Config, id: string): Config {
  if (!isCustomSubagent(id) || !Object.prototype.hasOwnProperty.call(config.subagentRoles, id)) return config;
  if (config.subagentRoles[id].enabled && enabledSubagentCount(config) <= 1) return config;
  const roles = { ...config.subagentRoles };
  delete roles[id];
  return { ...config, subagentRoles: roles };
}

export function selectSubagentModel(config: Config, id: string, option: SubagentModelOption): Config {
  const selection = config.subagentRoles[id];
  if (!selection) return config;
  return updateSubagent(config, id, {
    model: option.value,
    reasoningEffort: option.supportedReasoningEfforts.includes(selection.reasoningEffort)
      ? selection.reasoningEffort : option.defaultReasoningEffort,
  });
}

export function validateSubagents(config: Config): string | null {
  const limit = config.subagentMaxThreads ?? 2;
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) return "最大子代理数量必须是 1 到 64 之间的整数";
  if (config.subagentOptimization && enabledSubagentCount(config) === 0) return "至少需要保留一个启用的子代理角色";
  const custom = Object.entries(config.subagentRoles).filter(([id]) => isCustomSubagent(id));
  if (custom.length > 32) return "最多可配置 32 个自定义子代理";
  for (const [id, role] of custom) {
    for (const [label, value, limit] of [
      ["名称", role.name, 80], ["用途说明", role.description, 1000], ["角色指令", role.developerInstructions, 4000],
    ] as const) {
      if (!value?.trim() || new TextEncoder().encode(value).length > limit) {
        return `${role.name || id}的${label}不能为空且不能超过 ${limit} 字节`;
      }
    }
  }
  return null;
}
