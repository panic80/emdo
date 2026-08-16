import { Page, PageHeader } from '../components/page.js';
import { ConversationPanel } from '../features/chat/conversation.js';

export function AskRoute() {
  return (
    <Page className="conversation-page">
      <PageHeader
        title="Ask EMDO"
        description="One conversation for schedule, finance, shopping, and household plans."
      />
      <ConversationPanel />
    </Page>
  );
}
