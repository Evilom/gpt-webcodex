# 超级智囊团界面验证

final result: passed

Source visual truth: `C:/Users/Administrator/.codex/generated_images/01a10fc9-3d96-7a43-9f49-a65c4d23b741/exec-770bdc12-f5da-432c-a6c5-34aa364c32b8.png`.
Implementation: `build/shell-smoke/dark-interrupted.png`.
Full comparison: `build/shell-smoke/comparison-full.jpg`; focused toolbar comparison: `build/shell-smoke/comparison-header.jpg`.
Viewport: 1440 × 1024 CSS pixels. Source 1487 × 1058 normalized to 1440 × 1024; implementation 1440 × 1024, density 1. Small comparison previews inspected together, with the header checked separately.

State: dark mode, workbench open, ChatGPT interrupted, local MCP and Tunnel healthy. Additional captures cover ready/closed, ready/open, light mode, 960 × 640 and 640 × 600. Browser preview uses simulated chat and service data; native WebContentsView geometry is separately exercised in isolated Electron. The live app and Mac service were not controlled or restarted.

All six states also pass at 150% device scale (`build/shell-smoke-1-5/report.json`), with native geometry and eight core interaction checks passing. The source/implementation visual comparison uses density 1 screenshots; the 150% captures are supplementary geometry evidence.

## Findings and accepted differences

- Typography: Segoe UI / Microsoft YaHei UI, shell labels 12–15 px, panel headings 13–17 px. Labels remain horizontal; truncation is limited to paths and long status details, with full text in the workbench or tooltip.
- Spacing/layout: 56 px navigation plus border, a conditional 52 px incident strip, 300 px collapsible panel, 36 px footer. The compact navigation follows the user's first concept. The panel scrolls rather than shrinking labels or covering chat.
- Colors: original dark/teal tokens retained; amber reserved for connection problems. Light mode uses the existing light tokens. Each health state also has an explicit text label.
- Assets: user-requested new name and generated icon replace the concept's old branding. Heroicons 2.2.0 outline assets are supplied with their license. Native ChatGPT branding remains owned by ChatGPT; the preview chat is explicitly a fixture.
- Copy/content: all shell actions are Chinese. The new extension section is an intentional scope addition requested after the combined mock. Traffic is shown as accumulated bytes rather than an apparent context-window budget. The mock conversation differs from the concept because production keeps the original embedded ChatGPT page.

## Comparison history

1. P1: page interruption also marked the local task failed. Fixed by keeping the local task strip independent of webpage stream state; post-fix interrupted capture shows local idle and healthy services. Regression assertion included in the Electron smoke.
2. P2 in preview fixture: iframe retained its default intrinsic size. Fixed by applying the measured content dimensions; all six viewport/state captures now verify exact toolbar/footer/panel boundaries. The actual native view is verified separately.
3. Hidden test windows throttled animation frames, making the fixture timing unreliable. Disabled background throttling in the isolated smoke window; production runtime behavior was not changed by this test correction.
4. P1: a bottom history popover could be painted over by native chat. Added a bottom inset measured from its actual top, plus re-measurement after asynchronous history loading. Post-fix `historyReserved` interaction verifies the chat ends above the popover. Sidebar and incident inset updates now run immediately and are deduplicated.

## Interaction checks

Workbench open/close, More and Escape, console open/close, model catalog selection and simulated consultation return pass. There are no renderer console errors. Actual upstream inference and installation remain untested because the user requested keeping current tasks and services running.

P3: the mock chat content is intentionally shorter than the visual concept; it is not a production ChatGPT page redesign.
