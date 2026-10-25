---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 14f48488fead00d28e11c31f9845685c_b39559c6d03811f19f8752540064ee0f
    ReservedCode1: 5IipPMdqZzn9LJ6Jg+dxSFErn0ATbl6sJxqHkES3UJ3wBfgo5SYDwMaFha3wlwceNm/iMFLe2r7up3dH0mD8PWJFLCEzkjz+s/06AEjQcVHQ1eNYiTLpmFQpuzN2ni71E3NmlRcNXkep8U8TyjZx3CCOzSGiGLhPYVFTGOLwvRahLdwtxrprf7Kbd3o=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 14f48488fead00d28e11c31f9845685c_b39559c6d03811f19f8752540064ee0f
    ReservedCode2: 5IipPMdqZzn9LJ6Jg+dxSFErn0ATbl6sJxqHkES3UJ3wBfgo5SYDwMaFha3wlwceNm/iMFLe2r7up3dH0mD8PWJFLCEzkjz+s/06AEjQcVHQ1eNYiTLpmFQpuzN2ni71E3NmlRcNXkep8U8TyjZx3CCOzSGiGLhPYVFTGOLwvRahLdwtxrprf7Kbd3o=
---

# Lightning Shop · 设计系统文档

> 依据 ui-ux-pro-max skill 检索产出（两次 design-system 查询）综合定稿：
> 1) "organic food wholesale marketplace" → 紫色科技风（弃用）
> 2) "natural organic food grocery wholesale earthy warm" → Flat Design 生鲜绿 + 琥珀（采纳）

## 1. 设计方向

- **风格**：Flat Design（扁平化），适农产品/生鲜电商观感
- **情绪**：天然、新鲜、可信、克制
- **对比方案**：紫色科技风偏 SaaS，不符合农产品货盘的亲切感；生鲜绿 + 琥珀更贴合"产地直供、有机健康"心智

## 2. 色彩体系

| Token | 值 | 用途 |
| --- | --- | --- |
| `--primary` | `#059669` | 主色：品牌、主按钮、激活态、链接 |
| `--primary-dark` | `#047857` | Hover / 深色渐变 |
| `--primary-light` | `#ECFDF5` | 浅绿底：标签、辅助背景 |
| `--accent` | `#D97706` | 强调色：徽标、价格警示 |
| `--accent-dark` | `#B45309` | 强调 hover |
| `--ink` | `#1F2937` | 正文主色 |
| `--ink-soft` | `#4B5563` | 次级文字 |
| `--muted` | `#6B7280` | 弱化文字 |
| `--line` | `#E5E7EB` | 分割线/边框 |
| `--surface` | `#FFFFFF` | 卡片/页面 |
| `--surface-alt` | `#F9FAFB` | 区块底 |

**对比度**：正文 `#1F2937` on 白底 ≥ 12:1；弱化文字 ≥ 4.5:1；白字 on `#059669` = 4.85:1，达标。

## 3. 字体

| 角色 | 字体 | 回退 |
| --- | --- | --- |
| 标题（Display） | Lora 600 | Songti SC / serif |
| 正文（Body） | Raleway 400/600/700 | PingFang SC / Microsoft YaHei |

- 标题字号：Hero `clamp(30px, 5vw, 52px)`、区块 28px、卡片 17px
- 正文字号：17px（Hero 副文）/ 15px（按钮）/ 14px（Tab）/ 13px（辅助）

## 4. 布局与间距

- 容器最大宽 1200px，两侧 20px 内边距
- 栅格：`repeat(auto-fill, minmax(264px, 1fr))`，卡片间距 24px
- 间距刻度：4 / 8 / 12 / 16 / 24 / 28 / 32 / 48 / 64 / 72（4px 基准）
- 断点：1440 / 1024 / 768 / 375（768 以下单列工具条折叠、2 列 stats；375 以下产品 1 列）

## 5. 组件规范

| 组件 | 规范 |
| --- | --- |
| 主按钮 | 绿底白字、圆角 8px、hover 加深 + 阴影、active 下沉 1px |
| 幽灵按钮 | 透明底 + 半透明白描边（Hero 场景） |
| 分类 Tab | 胶囊形，激活=绿底白字，hover=绿描边 |
| 产品卡片 | 白底 1px 描边、圆角 14px、hover 抬升 3px + 大阴影 + 图片放大 1.04 |
| 价格区 | 上虚线下划线分隔；批发价红色加粗（`#DC2626`）、零售右对齐 |
| 徽标 | 琥珀底白字（火锅/其他品牌）、绿底白字（低GI） |
| 标签 | 浅绿底深绿字（资质）、米黄底琥珀字（起订量） |

**动效**：hover 150–300ms，`cubic-bezier(.4,0,.2,1)`；`prefers-reduced-motion` 全局关闭过渡。

## 6. 无障碍

- 语义标签：header/nav/main/section/footer、tablist/tab
- 图片含 `alt`，无图产品用占位符
- 键盘可聚焦 Tab、按钮；搜索框带 aria-label
- 输入聚焦态 3px 绿色外环

## 7. 图标与图片

- 不使用 emoji 做图标（Hero 徽标例外，属品牌符号），功能图标统一 SVG/内联图形
- 产品图统一 1:1 裁切（`object-fit: cover`）、懒加载
- R2 图片 URL `/img/:key`，Cache-Control 1 天

## 8. 响应式策略

- 375：单列产品、头部仅品牌 + 批发 CTA
- 768：2 列 stats、B2B 区块单列、工具栏纵向堆叠
- 1024–1440：完整 4 列 stats、双列 B2B、网格自适应
*（内容由AI生成，仅供参考）*
