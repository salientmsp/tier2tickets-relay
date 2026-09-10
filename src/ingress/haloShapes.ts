// Full Halo config-item shapes, field lists AUTO-DERIVED from docs/halo-swagger.v2.json
// (TStatus_List, RequestType_List, Policy, SectionDetail_List). Tier2 only reads
// id/name, but a strict Halo client (e.g. Huntress) deref's many fields — and filters
// these lists by selectability flags — when building its integration editor. So every
// field is present (defaulted) to avoid a client-side undefined access, and the
// "selectable"/"visible" flags are set true so a filtered list can't come back empty
// (which would crash a `list[0]` deref). These are picker options only; ticket creation
// still uses the DEFAULT_* ids from wrangler.toml.

/**
 * Full Halo TStatus_List object. `type` categorizes the status (Halo uses it for
 * open/pending/closed, driving the `excludeclosed`/`excludepending` filters): a
 * PSA integration editor reads it to offer both a "new" and a "closed/resolved"
 * status, so the list must span those categories or the closed-side lookup returns
 * undefined and crashes. `intent` carries a matching hint for name-based clients.
 */
export function haloStatus(id: number, name: string, type = 0, intent = ""): Record<string, unknown> {
  return {
    id,
    guid: "",
    intent,
    name,
    shortname: name,
    type,
    sequence: id,
    colour: "",
    slaaction: "",
    ticket_count: 0,
    showonquickchange: true,
    timeuntilloffhold: 0,
    statuschangeto: 0,
    statuschangetofreq: 0,
    useworkinghours: 0,
    statusemailfreqdays: 0,
    statusemailid: 0,
    statusemail_guid: "",
    statusnochangehours: 0,
    nochangehoursrecurring: false,
    statusnochangehoursmanager: 0,
    statusnochangehoursmanagerrecurring: false,
    statusnochangehourssection: 0,
    statusnochangehourssectionrecurring: false,
    nochangetemplate: 0,
    nochangetemplate_guid: "",
    includeinloadbalance: false,
    useworkinghours_statusnochangehours: 0,
    useworkinghours_statusnochangehourssection: 0,
    useworkinghours_statusnochangehoursmanager: 0,
  };
}

/** Full Halo RequestType_List (ticket type) object. */
export function haloTicketType(id: number, name: string): Record<string, unknown> {
  return {
    id,
    guid: "",
    intent: "",
    name,
    use: "",
    sequence: id,
    default_sla: 0,
    default_sla_guid: "",
    group_id: 0,
    group_name: "",
    jira_issue_type: "",
    ticket_count: 0,
    cancreate: true,
    agentscanselect: true,
    itilrequesttype: 0,
    allow_all_clients: true,
    allowattachments: true,
    copyattachmentstochild: false,
    copyattachmentstorelated: false,
    is_sprint: false,
    fieldidlist: [],
    enduserscanselect: true,
    anonymouscanselect: false,
    hasmandatorytechfields: false,
    hasmandatoryuserfields: false,
    project_type: 0,
    group_guid: "",
    kanbanstatuschoice: [],
    kanbanstatuschoice_list: "",
    email_start_tag: "",
    email_end_tag: "",
    default_agent: 0,
    default_agent_name: "",
    default_team: "",
    workflow_name: "",
    overridewiththefollowingtemplatewhenloggingmanuallyname: "",
    default_priority: 0,
    visible: true,
    webhook_id: "",
    _error: "",
  };
}

/** Full Halo Policy (priority) object. */
export function haloPriority(id: number, name: string): Record<string, unknown> {
  return {
    id,
    slaid: 0,
    sla_guid: "",
    priorityid: id,
    name,
    fixtime: 0,
    fixunits: "",
    enterslaexcuse: false,
    responsetime: 0,
    responseunits: "",
    ishidden: false,
    fixendofday: false,
    responseendofday: false,
    colour: "",
    catprompt: 0,
    workdaysoverride: 0,
    responsestartofday: false,
    responsestartofdaytime: "",
    startofday: false,
    startofdaytime: "",
    setfixtostartdate: false,
    setfixtotargetdate: false,
    translations: [],
    enterslaresponseexcuse: false,
    _warning: "",
    _isimport: false,
    _importtype: "",
    sla_name: "",
    firstresponsetime: 0,
    firstresponseunits: "",
  };
}

/** Full Halo SectionDetail_List (team) object. */
export function haloTeam(id: number, name: string): Record<string, unknown> {
  return {
    id,
    guid: "",
    intent: "",
    name,
    sequence: id,
    forrequests: true,
    foropps: false,
    forprojects: false,
    ticket_count: 0,
    department_id: 0,
    department_name: "",
    org_team_name: "",
    inactive: false,
    override_column_id: 0,
    agents: [],
    managers: [],
    teamphotopath: "",
    last_modified: null,
    hide_agents_in_tree_if_no_tickets: false,
    timesheet_approver: 0,
    timesheet_approver_name: "",
    concurrent_lic_limit: 0,
    use: "",
    department_guid: "",
    homescreendashboardid: 0,
    homescreendashboardname: "",
    customfields: [],
    mailbox_override: 0,
    hide_from_dropdowns: false,
    third_party_relational_id: "",
  };
}
