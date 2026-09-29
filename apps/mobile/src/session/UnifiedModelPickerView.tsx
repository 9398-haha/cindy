import type { ReactNode } from "react";
import {
  Star,
  SlidersHorizontal,
  Check,
  Zap,
  LayoutGrid,
} from "lucide-react-native";
import { MobileAgentMark } from "@/components/MobileAgentMark";
import { MobileModelIconMark, MobileProviderMark } from "./MobileProviderMark";
import { useState } from "react";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "@/components/AppText";
import { mobileInteractionStyles } from "@/components/mobileInteractionStyles";
import { useTheme, spacing, radius, iconSize } from "@/theme";
import { fontWeight, lineHeight, typeScale } from "@/theme/tokens";
import { SheetModal } from "./SheetModal";
import { SheetSurface } from "./SheetSurface";
import {
  computeContextSheetSnapHeights,
  type ContextSheetSnap,
} from "./contextSheetModel";
import { mobileAgentLabel } from "./sessionAgentSwitch";
import type { UnifiedMobilePickerViewProps } from "./UnifiedModelPickerSheet";
// 文字角色按 mobile-design-guide §3 整行取值(字号 / 行高 / 字重);字色随主题在渲染处注入。
const textRole = {
  /** 行标题、选项、按钮:16/22 500(textPrimary)。 */
  optionLabel: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  /** 行标题(模型名):16/22 500(textPrimary)。 */
  rowTitle: { flexShrink: 1, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  /** 次级正文(模型副标题):15/20 400(textSecondary)。 */
  rowSubtitle: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular },
  /** 短元数据(价格档、推理档、额度):12/18 400(textTertiary)。 */
  meta: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  /** 分组小标签:13/18 600(textTertiary)。 */
  groupLabel: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold, paddingTop: spacing.md },
  /** 说明 / 提示 / 报错(成句的话):13/18 400(textSecondary / errorText)。 */
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  /** 搜索框:bodySmall 字号;单行输入框不设行高。 */
  searchInput: { fontSize: typeScale.bodySmall, minHeight: 44 },
} as const;

export function UnifiedModelPickerView(p: UnifiedMobilePickerViewProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [snap, setSnap] = useState<ContextSheetSnap>("half");
  const button = (
    label: string,
    onPress: () => void,
    selected = false,
    icon?: ReactNode,
    disabled = false,
  ) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={p.busy || disabled}
      accessibilityState={{ disabled: p.busy || disabled, selected }}
      onPress={onPress}
      style={({ pressed }) => [
        {
          opacity: disabled ? 0.4 : 1,
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
          minHeight: 44,
          padding: spacing.md,
          backgroundColor: selected ? colors.surfaceChip : undefined,
          borderRadius: radius.pill,
        },
        pressed && mobileInteractionStyles.pressed,
      ]}
    >
      {icon}
      <Text style={[textRole.optionLabel, { color: colors.textPrimary }]}>{label}</Text>
    </Pressable>
  );
  const o = p.options;
  return (
    <SheetModal
      visible={p.visible}
      onClosed={p.onClosed}
      onBackdropPress={p.onClose}
      onRequestClose={p.onBack ?? p.onClose}
      keyboardAvoiding
    >
      <SheetSurface
        title={p.title}
        onBack={p.onBack}
        onClose={p.onClose}
        heights={computeContextSheetSnapHeights({
          screenHeight: height,
          safeAreaTopInset: insets.top,
        })}
        snap={snap}
        onSnapChange={setSnap}
        bottomInset={insets.bottom}
        testID={p.testID}
      >
        {p.error ? (
          <Text style={[textRole.note, { color: colors.errorText }]}>{p.error}</Text>
        ) : null}
        {o ? (
          <>
            <Text style={[textRole.note, { color: colors.textSecondary }]}>{o.context}</Text>
            <Text style={[textRole.groupLabel, { color: colors.textTertiary }]}>{t("models.unified.harness")}</Text>
            {o.agents.map((agent) =>
              button(
                mobileAgentLabel(agent),
                () => {
                  const cap = o.row.entry.capabilities[agent]!;
                  o.onChange({
                    ...o.row.config,
                    agent,
                    modelId: cap.wireModelId,
                    effort: cap.defaultEffort ?? cap.efforts[0] ?? "",
                    fast: false,
                  });
                },
                agent === o.row.config.agent,
                <MobileAgentMark
                  agentKind={agent}
                  color={colors.textSecondary}
                />,
              ),
            )}
            <Text style={[textRole.groupLabel, { color: colors.textTertiary }]}>{t("models.options.reasoningEffort")}</Text>
            {o.row.entry.capabilities[o.row.config.agent]?.efforts.map(
              (effort) =>
                button(
                  t(`models.options.effortLevels.${effort}`),
                  () => o.onChange({ ...o.row.config, effort }),
                  effort === o.row.config.effort,
                ),
            )}
            {o.fastCapable
              ? button(
                  t("models.options.fastMode"),
                  () =>
                    o.onChange({ ...o.row.config, fast: !o.row.config.fast }),
                  o.row.config.fast,
                  <Zap
                    size={iconSize.action}
                    color={colors.textSecondary}
                    fill={colors.textSecondary}
                  />,
                )
              : null}
            {o.price ? <Text style={[textRole.note, { color: colors.textSecondary }]}>{o.price}</Text> : null}
            {button(
              t(
                o.row.favorite
                  ? "models.unified.removeFavorite"
                  : "models.unified.addFavorite",
              ),
              o.onFavorite,
              false,
              <Star
                size={iconSize.action}
                color={colors.textSecondary}
                fill={o.row.favorite ? colors.textSecondary : "none"}
              />,
              o.favoritesDisabled,
            )}
            {!o.row.favorite
              ? button(t("models.unified.restoreRecommended"), o.onReset)
              : null}
          </>
        ) : (
          <>
            <TextInput
              value={p.query}
              onChangeText={p.onQuery}
              placeholder={t("models.picker.searchPlaceholder")}
              placeholderTextColor={colors.textPlaceholder}
              style={[textRole.searchInput, { color: colors.textPrimary }]}
            />
            <ScrollView horizontal>
              {p.filters.map((item) =>
                button(
                  item.quota
                    ? `${item.label} · ${item.quota.label}`
                    : item.label,
                  () => p.onFilter(item.id),
                  p.filter === item.id,
                  item.providerMark ? (
                    <View
                      accessibilityLabel={item.quota?.label}
                      style={{ alignItems: "center", gap: spacing.xs }}
                    >
                      <MobileProviderMark {...item.providerMark} />
                      {item.quota ? (
                        <View
                          accessibilityRole="progressbar"
                          accessibilityValue={{
                            min: 0,
                            max: 100,
                            now: item.quota.remaining,
                          }}
                          style={{
                            width: 24,
                            height: 3,
                            borderRadius: radius.pill,
                            backgroundColor: colors.surfaceChip,
                            overflow: "hidden",
                          }}
                        >
                          <View
                            style={{
                              width: `${item.quota.remaining}%`,
                              height: "100%",
                              backgroundColor: colors.textSecondary,
                            }}
                          />
                        </View>
                      ) : null}
                    </View>
                  ) : item.id === "favorites" ? (
                    <Star size={iconSize.action} color={colors.textSecondary} />
                  ) : (
                    <LayoutGrid
                      size={iconSize.action}
                      color={colors.textSecondary}
                    />
                  ),
                ),
              )}
            </ScrollView>
            {p.groups.map((group) => (
              <View key={group.key}>
                <Text style={[textRole.groupLabel, { color: colors.textTertiary }]}>{group.title}</Text>
                {group.rows.map((row) => (
                  <View
                    key={row.key}
                    style={{ flexDirection: "row", alignItems: "center" }}
                  >
                    <Pressable
                      disabled={p.busy || row.disabled}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: p.busy || row.disabled, selected: row.selected }}
                      onPress={() => p.onSelect(row)}
                      style={({ pressed }) => [
                        {
                          flex: 1,
                          minHeight: 52,
                          padding: spacing.md,
                          flexDirection: "row",
                          alignItems: "center",
                          gap: spacing.sm,
                        },
                        pressed && mobileInteractionStyles.pressed,
                      ]}
                    >
                      <MobileModelIconMark
                        icon={row.entry.icon}
                        {...row.providerMark}
                      />
                      <View style={{ flex: 1 }}>
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: spacing.xs,
                          }}
                        >
                          <Text numberOfLines={1} style={[textRole.rowTitle, { color: colors.textPrimary }]}>
                            {row.entry.displayName}
                          </Text>
                          {row.costMarks ? (
                            <Text style={[textRole.meta, { color: colors.textTertiary }]}>{row.costMarks}</Text>
                          ) : null}
                          <MobileAgentMark
                            agentKind={row.config.agent}
                            color={colors.textSecondary}
                          />
                          <Text style={[textRole.meta, { color: colors.textTertiary }]}>{row.effortLabel}</Text>
                          {row.config.fast ? (
                            <Zap
                              size={iconSize.sm}
                              color={colors.textSecondary}
                            />
                          ) : null}
                        </View>
                        {row.subtitle ? (
                          <Text numberOfLines={1} style={[textRole.rowSubtitle, { color: colors.textSecondary }]}>
                            {row.subtitle}
                          </Text>
                        ) : null}
                        {row.quotaLabel ? (
                          <Text style={[textRole.meta, { color: colors.textTertiary }]}>{row.quotaLabel}</Text>
                        ) : null}
                      </View>
                      {row.favorite ? (
                        <Star
                          size={iconSize.action}
                          color={colors.textSecondary}
                          fill={colors.textSecondary}
                        />
                      ) : null}
                      {row.selected ? (
                        <Check
                          size={iconSize.action}
                          color={colors.textSecondary}
                        />
                      ) : null}
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t(
                        "models.picker.configureAccessibility",
                        { model: row.entry.displayName },
                      )}
                      disabled={p.busy || row.disabled}
                      onPress={() => p.onOptions(row)}
                      style={({ pressed }) => [
                        {
                          width: 44,
                          height: 44,
                          alignItems: "center",
                          justifyContent: "center",
                        },
                        pressed && mobileInteractionStyles.pressed,
                      ]}
                    >
                      <SlidersHorizontal
                        size={iconSize.action}
                        color={colors.textSecondary}
                      />
                    </Pressable>
                  </View>
                ))}
              </View>
            ))}
            {!p.groups.length ? (
              <Text style={[textRole.note, { color: colors.textSecondary }]}>
                {p.loading ? t("models.picker.loadingDefault") : p.emptyHint}
              </Text>
            ) : null}
          </>
        )}
      </SheetSurface>
    </SheetModal>
  );
}
