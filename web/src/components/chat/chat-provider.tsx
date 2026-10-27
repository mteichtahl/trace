/**
 * The CopilotKit v2 provider for the whole app, with trace's agent registered as a self-managed AG-UI HttpAgent at
 * /api/agui (no CopilotKit runtime: the web backend is the AG-UI endpoint, and it checks the token and project access
 * on every request). Renderers for tool calls and the `ask_person` decision card, and the context bridge, mount here.
 *
 * Note: CopilotKit logs that `selfManagedAgents` is part of its licensed tier when no publicLicenseKey is given; the
 * key, if the installation has one, comes from VITE_COPILOTKIT_LICENSE.
 */
import { CopilotKitProvider } from '@copilotkit/react-core/v2'
import { useMemo, type ReactNode } from 'react'
import { AGENT_ID, FOCUS_AGENT_ID, createTraceAgent } from './agent'
import { ContextBridge } from './context'
import { ChatRenderers } from './renderers'

export function ChatProvider({ children }: { children: ReactNode }) {
  const agents = useMemo(() => ({ [AGENT_ID]: createTraceAgent(AGENT_ID), [FOCUS_AGENT_ID]: createTraceAgent(FOCUS_AGENT_ID) }), [])
  const license = import.meta.env.VITE_COPILOTKIT_LICENSE as string | undefined
  return (
    <CopilotKitProvider selfManagedAgents={agents} agentId={AGENT_ID} showIntelligenceIndicator={false} enableInspector={false} {...(license ? { publicLicenseKey: license } : {})}>
      <ContextBridge />
      <ChatRenderers />
      {children}
    </CopilotKitProvider>
  )
}
