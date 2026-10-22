import { memo } from "react";
import {
  IconCode, IconDeviceDesktopCode, IconFocus2, IconInfoCircle, IconPhotoSearch,
  IconPlus, IconTrash, IconUsersGroup, IconWorldSearch,
} from "@tabler/icons-react";
import { Button, Input, NumberInput, Select, Switch, TextArea } from "../../components/ui";
import { ModelCombobox } from "../../components/ModelCombobox";
import { SettingsPageHeader } from "../../SettingsPageHeader";
import { resolveSubagentModelOption } from "../../subagentModels";
import { BUILTIN_SUBAGENT_ROLES, enabledSubagentCount, isCustomSubagent } from "./state";
import { useSubagentsController, type SubagentPolicyCardProps } from "./useSubagentsController";

const ROLE_ICONS = [IconFocus2, IconWorldSearch, IconPhotoSearch, IconCode, IconDeviceDesktopCode];
const EFFORT_LABELS: Record<string, string> = {
  none: "无", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大", ultra: "超高",
};

function SubagentPolicyCardComponent(props: SubagentPolicyCardProps) {
  const { config, isBusy, subagentModelOptions } = props;
  const controller = useSubagentsController(props);
  const enabledCount = enabledSubagentCount(config);
  const customRoles = Object.keys(config.subagentRoles).filter(isCustomSubagent);

  const renderRole = (id: string) => {
    const builtin = BUILTIN_SUBAGENT_ROLES.find(role => role.id === id);
    const custom = !builtin;
    const selection = config.subagentRoles[id];
    if (!selection) return null;
    const name = builtin?.name ?? (selection.name || "自定义子代理");
    const RoleIcon = builtin ? ROLE_ICONS[BUILTIN_SUBAGENT_ROLES.indexOf(builtin)] : IconUsersGroup;
    const selectedModel = resolveSubagentModelOption(subagentModelOptions, selection.model, controller.preferredProviderId);
    const efforts = selectedModel?.supportedReasoningEfforts ?? [];
    const disabled = isBusy || !selection.enabled;
    const lastEnabled = selection.enabled && enabledCount <= 1;
    return (
      <div key={id} id={id} className={`subagent-role-item ${selection.enabled ? "" : "subagent-role-disabled"}`}>
        <div className="subagent-role-item-header">
          <div className="subagent-role-identity">
            <div className={`subagent-role-icon-box subagent-role-icon-box--${builtin?.id ?? "default"}`}>
              <RoleIcon size={18} aria-hidden="true" />
            </div>
            <div className="subagent-role-meta">
              <div className="subagent-role-title-row">
                <h4 className="subagent-role-name">{name}</h4>
                {!selection.enabled && <span className="subagent-role-status-chip">已停用</span>}
              </div>
              <p className="subagent-role-description">{builtin?.description ?? selection.description}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {custom && (
              <Button size="xs" variant="ghost" disabled={isBusy || lastEnabled}
                aria-label={`删除${name}`} onClick={() => controller.removeRole(id)}>
                <IconTrash size={15} />
              </Button>
            )}
            <Switch checked={selection.enabled} disabled={isBusy || lastEnabled}
              onCheckedChange={enabled => controller.updateRole(id, { enabled })}
              aria-label={`${selection.enabled ? "关闭" : "启用"}${name}角色`} />
          </div>
        </div>
        {custom && (
          <div className="grid gap-3 pb-3">
            <label className="grid gap-1 text-xs">
              名称
              <Input aria-label="名称" value={selection.name ?? ""} disabled={isBusy}
                onChange={event => controller.updateRole(id, { name: event.target.value })} />
            </label>
            <label className="grid gap-1 text-xs">
              用途说明
              <Input aria-label="用途说明" value={selection.description ?? ""} disabled={isBusy}
                placeholder="主代理在什么情况下选择这个角色"
                onChange={event => controller.updateRole(id, { description: event.target.value })} />
            </label>
            <label className="grid gap-1 text-xs">
              角色指令
              <TextArea aria-label="角色指令" value={selection.developerInstructions ?? ""}
                disabled={isBusy} rows={3}
                onChange={event => controller.updateRole(id, { developerInstructions: event.target.value })} />
            </label>
            <div className="subagent-control-group">
              <label className="subagent-control-label">读写能力</label>
              <Select aria-label={`${name}读写能力`} value={selection.access ?? "readWrite"} disabled={disabled} filter={false}
                optionList={[{ value: "readOnly", label: "只读" }, { value: "readWrite", label: "可读写" }]}
                onChange={value => {
                  if (value === "readOnly" || value === "readWrite") controller.updateRole(id, { access: value });
                }} />
              <small className="text-[var(--codey-muted)]">只读允许检索、读取图片和回报，限制命令、编辑及可能改变状态的工具；可读写仍受父任务权限约束。</small>
            </div>
          </div>
        )}
        <div className="subagent-role-controls-row">
          <div className="subagent-control-group subagent-control-group--model">
            <label className="subagent-control-label">指定模型</label>
            <div className="subagent-control-field">
              <ModelCombobox aria-label={`${name}模型`} value={selection.model}
                disabled={disabled || subagentModelOptions.length === 0} options={subagentModelOptions}
                preferredProviderId={controller.preferredProviderId}
                placeholder={subagentModelOptions.length ? "请选择模型" : "所有线路均暂无模型"}
                onChange={value => controller.changeModel(id, value)} />
            </div>
          </div>
          <div className="subagent-control-group subagent-control-group--effort">
            <label className="subagent-control-label">思考深度</label>
            <div className="subagent-control-field">
              <Select className="w-full min-w-0" aria-label={`${name}思考深度`}
                value={efforts.includes(selection.reasoningEffort) ? selection.reasoningEffort : undefined}
                placeholder="暂无可选深度" disabled={disabled || !efforts.length} filter={false}
                optionList={efforts.map(value => ({ value, label: EFFORT_LABELS[value] ?? value }))}
                onChange={value => controller.updateRole(id, { reasoningEffort: String(value ?? "") })} />
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <section className="secondary-section subagent-section" aria-labelledby="subagent-title">
      <div className="subagent-settings">
        <SettingsPageHeader id="subagent-title" title="子代理优化" icon={<IconUsersGroup size={15} />}
          description="保留内置角色，并按任务添加自己的子代理。"
          actions={<Switch checked={config.subagentOptimization} disabled={isBusy}
            onCheckedChange={controller.changeOptimization} aria-label="启用子代理优化" />} />
        <div className="module-card-body subagent-policy-body">
          {config.subagentOptimization ? <>
            <div className="subagent-group-card codey-card p-4">
              <div className="grid gap-2">
                <label className="subagent-control-label">最大并发子代理数量</label>
                <NumberInput aria-label="最大并发子代理数量" minValue={1} maxValue={64} step={1}
                  value={config.subagentMaxThreads ?? 2} disabled={isBusy} onChange={controller.changeMaxThreads} />
                <small className="text-[var(--codey-muted)]">不包含主代理；保存后重启 Codex 生效。</small>
              </div>
            </div>
            {(["analysis", "implementation"] as const).map(kind => (
              <div key={kind} className="subagent-group-card codey-card">
                <div className="subagent-group-header">
                  <span className="subagent-group-title">{kind === "analysis" ? "分析角色" : "实施角色"}</span>
                  <span className="subagent-group-desc">内置角色 · 可读写，受父任务权限约束</span>
                </div>
                <div className="subagent-group-items">
                  {BUILTIN_SUBAGENT_ROLES.filter(role => role.kind === kind).map(role => renderRole(role.id))}
                </div>
              </div>
            ))}
            <div className="subagent-group-card codey-card">
              <div className="subagent-group-header">
                <span className="subagent-group-title">自定义子代理</span>
                <Button size="sm" disabled={isBusy || customRoles.length >= 32} onClick={controller.addRole}>
                  <IconPlus size={15} />添加子代理
                </Button>
              </div>
              <div className="subagent-group-items">
                {customRoles.length ? customRoles.map(renderRole) : (
                  <p className="p-4 text-sm text-[var(--codey-muted)]">
                    为专项任务添加角色，配置用途、指令、读写能力、模型和思考深度。
                  </p>
                )}
              </div>
            </div>
            {controller.error && <p role="alert" className="text-sm text-[var(--codey-red)]">{controller.error}</p>}
            <div className="subagent-policy-callout">
              <IconInfoCircle size={16} className="subagent-callout-icon" aria-hidden="true" />
              <div className="subagent-callout-text">
                {subagentModelOptions.length === 0
                  ? "请先在模型管理中为可用线路启用模型。"
                  : "已有角色的配置保存后对下次派生生效，正在运行的子代理沿用原配置。新增角色需保存并重启 Codex；派发时必须选择已启用角色。"}
                {" "}<a href="https://learn.chatgpt.com/docs/agent-configuration/subagents"
                  target="_blank" rel="noreferrer" className="underline">官方子代理文档</a>
              </div>
            </div>
          </> : (
            <div className="module-disabled-placeholder">
              <div className="module-disabled-icon"><IconUsersGroup size={20} /></div>
              <div className="module-disabled-text">
                <strong>子代理优化已关闭</strong>
                <p>开启后可使用内置与自定义角色，并配置并发数量、模型和思考深度。</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export const SubagentPolicyCard = memo(SubagentPolicyCardComponent);
