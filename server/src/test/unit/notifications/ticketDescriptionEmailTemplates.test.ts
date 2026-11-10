import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { formatBlockNoteContent } from '@alga-psa/formatting/blocknoteUtils';
import { StaticTemplateProcessor } from '@alga-psa/email';

const require = createRequire(import.meta.url);

const templates = [
  'ticketAssigned.cjs',
  'ticketCreated.cjs',
  'ticketCreatedClient.cjs',
  'ticketTeamAssigned.cjs',
];

describe('ticket description email templates', () => {
  it.each(templates)('%s uses rich HTML and plain-text description fields', (fileName) => {
    const templateModule = require(`../../../../migrations/utils/templates/email/tickets/${fileName}`) as {
      getTemplate: () => {
        translations: Array<{ htmlContent: string; textContent: string }>;
      };
    };

    for (const translation of templateModule.getTemplate().translations) {
      expect(translation.htmlContent).toContain('{{{ticket.descriptionHtml}}}');
      expect(translation.textContent).toContain('{{ticket.descriptionText}}');
      expect(translation.textContent).not.toContain('{{{ticket.description}}}');
      expect(translation.textContent).not.toContain('{{ticket.summary}}');
    }
  });

  it.each([...templates, 'ticketCommentAdded.cjs'])('%s renders structured content without escaping or dropping its table', async (fileName) => {
    const templateModule = require(`../../../../migrations/utils/templates/email/tickets/${fileName}`) as {
      getTemplate: () => { translations: Array<{ htmlContent: string; textContent: string }> };
    };
    const formatted = formatBlockNoteContent([
      { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Setup Requirements' }] },
      { type: 'table', content: { type: 'tableContent', rows: [{ cells: [
        { type: 'tableCell', content: [{ type: 'text', text: 'Data Transfer' }] },
        { type: 'tableCell', content: [{ type: 'text', text: '50gb' }] },
      ] }] } },
      { type: 'checkListItem', props: { checked: true }, content: [{ type: 'text', text: 'Wi-Fi' }] },
    ]);
    for (const translation of templateModule.getTemplate().translations) {
      const processor = new StaticTemplateProcessor('', translation.htmlContent, translation.textContent);
      const result = await processor.process({ templateData: {
        ticket: { descriptionHtml: formatted.html, descriptionText: formatted.text },
        comment: { content: formatted.html, text: formatted.text },
      } });
      expect(result.html).toContain('<h2>Setup Requirements</h2>');
      expect(result.html).toMatch(/<td\b[^>]*>Data Transfer<\/td>/);
      expect(result.html).toMatch(/<td\b[^>]*>50gb<\/td>/);
      expect(result.html).toContain('<s>Wi-Fi</s>');
      expect(result.html).not.toContain('&lt;table');
      expect(result.text).toContain('| Data Transfer | 50gb |');
      expect(result.text).toContain('- [x] Wi-Fi');
      expect(result.text).not.toMatch(/<(?:table|td|h2|s)\b/);
    }
  });
});
