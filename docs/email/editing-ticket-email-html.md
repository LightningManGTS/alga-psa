# Ticket-closed detail variables (1/3)

The existing `ticket-closed` notification exposes plain-data arrays for custom
templates. Stock templates, notification routing and existing translations are
unchanged. These variables are not added to other ticket notifications.

| Variable | Contents |
|---|---|
| `ticket.assets` | `assetTag`, `name`, `assetType`, `manufacturer`, `model`, `serialNumber`, `status`, `location`, `relationship` |
| `ticket.materials` | `name`, `description`, `quantity`, `rate`, `amount`, `currencyCode`, `billed` |
| `ticket.timeEntries` | `date`, `technician`, `worked`, `billable` |
| `ticket.materialsTotal` | Currency-formatted material totals; different currencies are listed separately, not added together |
| `ticket.totalTimeWorked` | All recorded worked time |
| `ticket.totalTimeBillable` | Recorded billable time, including uninvoiced time |
| `ticket.remainingBlockHours` | Available, unexpired prepaid hours at send time |

Empty arrays are `[]`; missing asset fields are empty strings. Material quantities
are numbers and `billed` is a boolean. Material rates and amounts use each row's
currency. Durations use the existing hours/minutes formatter. Time-entry dates
use `MM/DD/YYYY` in the email's existing effective timezone; rows are ordered by
work timestamp, technician and entry ID. Multiple entries for the same technician
remain separate. No translation lookup or HTML rendering is performed.

## Editable time table

This replaces a pre-rendered time table with the same four columns. All table
markup, labels and styling belong to the custom template; remove a header and
its matching cell to omit a column. Use ordinary double braces to escape values.

```handlebars
{{#if ticket.timeEntries}}
<table style="border-collapse:collapse;width:100%;font-size:13px;">
  <thead>
    <tr>
      <th style="text-align:left;padding:6px 10px;">Date</th>
      <th style="text-align:left;padding:6px 10px;">Technician</th>
      <th style="text-align:left;padding:6px 10px;">Worked</th>
      <th style="text-align:left;padding:6px 10px;">Billable</th>
    </tr>
  </thead>
  <tbody>
    {{#each ticket.timeEntries}}
    <tr>
      <td style="padding:6px 10px;">{{date}}</td>
      <td style="padding:6px 10px;">{{technician}}</td>
      <td style="padding:6px 10px;">{{worked}}</td>
      <td style="padding:6px 10px;">{{billable}}</td>
    </tr>
    {{/each}}
  </tbody>
</table>
{{/if}}
<p>Worked: {{ticket.totalTimeWorked}} · Billable: {{ticket.totalTimeBillable}}</p>
<p>Remaining Block Hours: {{ticket.remainingBlockHours}}</p>
```

For plain-text content, use the same array without HTML:

```handlebars
{{#each ticket.timeEntries}}
Date: {{date}}
Technician: {{technician}}
Worked: {{worked}}
Billable: {{billable}}

{{/each}}
```

Use the same `{{#each ticket.assets}}` or `{{#each ticket.materials}}` pattern
for those arrays. There are no `assetsHtml`, `materialsHtml` or `timeHtml`
variables. Existing personal templates using those experimental variables must
replace them with array loops before using the narrowed implementation.
