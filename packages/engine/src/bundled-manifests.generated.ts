// GENERATED FILE — do not edit by hand. Run `pnpm --filter @gtmgrid/engine gen:bundled-manifests`.
// Connector manifests bundled with the app (repo `extensions/*.json`), inlined so the
// cloud webhook worker (which has no disk access to `extensions/`) can register them.
/* eslint-disable */
/** The connector manifests shipped with the app, as raw JSON (parse via `parseManifest`). */
export const BUNDLED_MANIFESTS: readonly unknown[] = [
  {
    "id": "apify",
    "name": "Apify",
    "version": "1.0.0",
    "category": "scraping",
    "description": "Run any Apify actor/scraper and get results back per row. Run-sync returns dataset items in one call.",
    "baseUrl": "https://api.apify.com/v2",
    "logo": "https://www.google.com/s2/favicons?domain=apify.com&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "Authorization",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rps": 60,
      "concurrency": 5
    },
    "methods": [
      {
        "id": "runActorSync",
        "label": "Run Actor (sync, get items)",
        "description": "Run an actor and get its dataset items back in a single call. `actorId` is the actor identifier in the form 'username~actorname' (e.g. 'apify~website-content-crawler'). EVERY OTHER field you pass becomes the actor's input JSON (the input schema is specific to each actor). Returns an array of result items directly. Note: 5-minute timeout — use the async runActor + getDatasetItems for long runs.",
        "verb": "POST",
        "path": "/acts/{actorId}/run-sync-get-dataset-items",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "actorId"
          ],
          "properties": {
            "actorId": {
              "type": "string",
              "description": "Actor id, format 'username~actorname', e.g. 'apify~website-content-crawler'"
            }
          }
        },
        "category": "Scraping",
        "options": {
          "actorId": {
            "method": "listActors",
            "itemsPath": "data.items",
            "labelKey": "title",
            "valueKey": "id",
            "sublabelKey": "username",
            "args": {
              "my": 1,
              "limit": 1000
            }
          }
        },
        "rateLimit": {
          "rps": 3
        }
      },
      {
        "id": "runActor",
        "label": "Run Actor (async start)",
        "description": "Start an actor run asynchronously. `actorId` is 'username~actorname'; every other field is the actor input. Returns { data: { id, defaultDatasetId, status } } — fetch results later with Get Dataset Items using defaultDatasetId.",
        "verb": "POST",
        "path": "/acts/{actorId}/runs",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "actorId"
          ],
          "properties": {
            "actorId": {
              "type": "string",
              "description": "Actor id, format 'username~actorname'"
            }
          }
        },
        "category": "Scraping",
        "options": {
          "actorId": {
            "method": "listActors",
            "itemsPath": "data.items",
            "labelKey": "title",
            "valueKey": "id",
            "sublabelKey": "username",
            "args": {
              "my": 1,
              "limit": 1000
            }
          }
        },
        "rateLimit": {
          "rps": 3
        }
      },
      {
        "id": "getDatasetItems",
        "label": "Get Dataset Items",
        "description": "Fetch items from a dataset (use defaultDatasetId from an async run). Returns an array of result items.",
        "verb": "GET",
        "path": "/datasets/{datasetId}/items",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "datasetId"
          ],
          "properties": {
            "datasetId": {
              "type": "string",
              "description": "Dataset id (defaultDatasetId from a run)"
            },
            "clean": {
              "type": "boolean"
            },
            "limit": {
              "type": "integer"
            },
            "offset": {
              "type": "integer"
            }
          }
        },
        "category": "Scraping",
        "options": {
          "datasetId": {
            "method": "listDatasets",
            "itemsPath": "data.items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "itemCount",
            "args": {
              "limit": 1000
            }
          }
        }
      },
      {
        "id": "me",
        "label": "Account Info",
        "description": "Get the authenticated user (plan, usage). Returns { data: { id, username, plan } }.",
        "verb": "GET",
        "path": "/users/me",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "listActors",
        "label": "List Actors",
        "description": "List your account's Actors (paginated). Use my=1 to limit to Actors you own/created. Returns { data: { items: [{ id, name, username, title }] } }. The item `id` works directly as `actorId` on the run endpoints (so does username~name).",
        "verb": "GET",
        "path": "/acts",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "my": {
              "type": "integer",
              "description": "Set 1 to list only Actors you own"
            },
            "limit": {
              "type": "integer",
              "description": "Max items (default 1000)"
            },
            "offset": {
              "type": "integer",
              "description": "Pagination offset"
            },
            "sortBy": {
              "type": "string",
              "description": "createdAt | stats.lastRunStartedAt"
            }
          }
        },
        "category": "Scraping"
      },
      {
        "id": "listDatasets",
        "label": "List Datasets",
        "description": "List your datasets (paginated). Returns { data: { items: [{ id, name, title, itemCount, actId }] } }. Use a dataset `id` as `datasetId` for getDatasetItems.",
        "verb": "GET",
        "path": "/datasets",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "unnamed": {
              "type": "boolean",
              "description": "Include unnamed (run-default) datasets"
            },
            "limit": {
              "type": "integer",
              "description": "Max items (default 1000)"
            },
            "offset": {
              "type": "integer",
              "description": "Pagination offset"
            },
            "desc": {
              "type": "boolean",
              "description": "Sort descending by createdAt"
            }
          }
        },
        "category": "Scraping"
      }
    ]
  },
  {
    "id": "apollo",
    "name": "Apollo.io",
    "version": "1.0.0",
    "category": "enrichment",
    "description": "Sales intelligence — enrich people & companies and search Apollo's B2B database.",
    "baseUrl": "https://api.apollo.io/api/v1",
    "logo": "https://www.google.com/s2/favicons?domain=apollo.io&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "X-Api-Key",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 200,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "enrichPerson",
        "label": "Enrich Person",
        "description": "Enrich a person from name + company (or email/LinkedIn). Returns { person } with title, email, email_status, linkedin_url, organization, etc. Set reveal_personal_emails to also return personal emails. 1 credit.",
        "verb": "POST",
        "path": "/people/match",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "first_name": {
              "type": "string"
            },
            "last_name": {
              "type": "string"
            },
            "name": {
              "type": "string",
              "description": "Full name (alternative to first+last)"
            },
            "email": {
              "type": "string",
              "description": "Known email (best identifier)"
            },
            "organization_name": {
              "type": "string",
              "description": "Employer company name"
            },
            "domain": {
              "type": "string",
              "description": "Employer domain, e.g. 'stripe.com'"
            },
            "linkedin_url": {
              "type": "string"
            },
            "reveal_personal_emails": {
              "type": "boolean",
              "description": "Also return personal emails"
            }
          }
        },
        "category": "Enrich people"
      },
      {
        "id": "bulkEnrichPeople",
        "label": "Bulk Enrich People",
        "description": "Enrich up to 10 people in one call. Provide `details` as an array of person objects (same fields as Enrich Person). Returns { matches: [...] }.",
        "verb": "POST",
        "path": "/people/bulk_match",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "details"
          ],
          "properties": {
            "details": {
              "type": "array",
              "description": "Up to 10 person objects",
              "items": {
                "type": "object",
                "properties": {
                  "first_name": {
                    "type": "string"
                  },
                  "last_name": {
                    "type": "string"
                  },
                  "organization_name": {
                    "type": "string"
                  },
                  "domain": {
                    "type": "string"
                  },
                  "email": {
                    "type": "string"
                  }
                }
              }
            },
            "reveal_personal_emails": {
              "type": "boolean"
            }
          }
        },
        "category": "Enrich people",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "enrichOrganization",
        "label": "Enrich Organization",
        "description": "Enrich a company from its domain. Returns { organization } with name, industry, estimated_num_employees, linkedin_url, annual_revenue, founded_year, logo_url, etc. 1 credit.",
        "verb": "GET",
        "path": "/organizations/enrich",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "domain"
          ],
          "properties": {
            "domain": {
              "type": "string",
              "description": "Company domain, no http:// or www."
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "searchPeople",
        "label": "Search People",
        "description": "Search Apollo's people database by title, seniority, location, company. Returns { people, pagination }. Does NOT return emails — pipe results into Enrich Person. Requires a master API key.",
        "verb": "POST",
        "path": "/mixed_people/api_search",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "person_titles": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "e.g. ['VP of Sales']"
            },
            "person_seniorities": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "e.g. ['c_suite','vp','director']"
            },
            "person_locations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "organization_locations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "q_organization_domains_list": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "organization_num_employees_ranges": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "e.g. ['11,50','51,200']"
            },
            "q_keywords": {
              "type": "string"
            },
            "page": {
              "type": "integer"
            },
            "per_page": {
              "type": "integer",
              "description": "Max 100"
            }
          }
        },
        "category": "Search",
        "rateLimit": {
          "rpm": 100
        }
      },
      {
        "id": "searchOrganizations",
        "label": "Search Companies",
        "description": "Search Apollo's company database by name, size, location, keywords. Returns { organizations, pagination }.",
        "verb": "POST",
        "path": "/mixed_companies/search",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "q_organization_name": {
              "type": "string"
            },
            "organization_num_employees_ranges": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "organization_locations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "q_organization_keyword_tags": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "page": {
              "type": "integer"
            },
            "per_page": {
              "type": "integer"
            }
          }
        },
        "category": "Search",
        "rateLimit": {
          "rpm": 100
        }
      },
      {
        "id": "searchSequences",
        "label": "Search Sequences",
        "description": "Search Apollo sequences (emailer campaigns) created by your team. Returns { emailer_campaigns: [{ id, name, active, num_steps, ... }] }. Requires a master API key.",
        "verb": "POST",
        "path": "/emailer_campaigns/search",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "q_name": {
              "type": "string",
              "description": "Filter sequences by name"
            },
            "page": {
              "type": "integer"
            },
            "per_page": {
              "type": "integer",
              "description": "Max 100"
            }
          }
        },
        "category": "Sequences"
      },
      {
        "id": "listEmailAccounts",
        "label": "List Email Accounts",
        "description": "List the linked sending email accounts (mailboxes) on your Apollo account. Returns { email_accounts: [{ id, email, type, active, default, ... }] }. Use an account id for send_email_from_email_account_id when adding contacts to a sequence. Requires a master API key.",
        "verb": "GET",
        "path": "/email_accounts",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        },
        "category": "Sequences"
      },
      {
        "id": "addContactsToSequence",
        "label": "Add Contacts to Sequence",
        "description": "Add existing Apollo contacts to a sequence (emailer campaign). Provide the sequence id plus contact_ids[] (or label_names[]) and send_email_from_email_account_id (the mailbox to send from). Rate limited to 600 calls/hour. Requires a master API key.",
        "verb": "POST",
        "path": "/emailer_campaigns/{sequence_id}/add_contact_ids",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "sequence_id",
            "emailer_campaign_id",
            "send_email_from_email_account_id"
          ],
          "properties": {
            "sequence_id": {
              "type": "string",
              "description": "Sequence (emailer campaign) id — path param"
            },
            "emailer_campaign_id": {
              "type": "string",
              "description": "Sequence id again (body); must match sequence_id"
            },
            "contact_ids": {
              "type": "array",
              "description": "Apollo contact ids to add",
              "items": {
                "type": "string"
              }
            },
            "label_names": {
              "type": "array",
              "description": "Alternative: add all contacts carrying these list/label names",
              "items": {
                "type": "string"
              }
            },
            "send_email_from_email_account_id": {
              "type": "string",
              "description": "Mailbox (email account) id to send from"
            },
            "sequence_no_email": {
              "type": "boolean",
              "description": "Add contacts without sending the first email step"
            }
          }
        },
        "options": {
          "sequence_id": {
            "method": "searchSequences",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "active",
            "args": {
              "per_page": 100
            }
          },
          "emailer_campaign_id": {
            "method": "searchSequences",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "active",
            "args": {
              "per_page": 100
            }
          },
          "send_email_from_email_account_id": {
            "method": "listEmailAccounts",
            "labelKey": "email",
            "valueKey": "id"
          }
        },
        "rateLimit": {
          "rps": 1
        },
        "category": "Sequences"
      }
    ]
  },
  {
    "id": "attio",
    "name": "Attio",
    "version": "1.0.0",
    "category": "crm",
    "description": "Attio CRM — read and write people, companies, deals and custom-object records, manage lists, attributes, notes, tasks, comments and webhooks via the Attio v2 REST API.",
    "logo": "https://www.google.com/s2/favicons?domain=attio.com&sz=128",
    "baseUrl": "https://api.attio.com",
    "auth": {
      "type": "apiKey",
      "header": "Authorization",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rps": 25
    },
    "methods": [
      {
        "id": "identifySelf",
        "label": "Identify Token (Self)",
        "description": "Identify the current access token: returns { active, scope, client_id, token_type, authorized_by_workspace_member_id, workspace_id, workspace_name, workspace_slug, workspace_logo_url }. Use to confirm auth and discover the workspace. No inputs. Free.",
        "verb": "GET",
        "path": "/v2/self",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "listObjects",
        "label": "List Objects",
        "description": "List all system and custom objects in the workspace (people, companies, deals, users, workspaces + any custom objects). Returns { data: [{ id:{ workspace_id, object_id }, api_slug, singular_noun, plural_noun, created_at }] }. No inputs. Free.",
        "verb": "GET",
        "path": "/v2/objects",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "getObject",
        "label": "Get Object",
        "description": "Get a single object's config by id or api_slug (e.g. 'people', 'companies', 'deals'). Returns { data:{ id, api_slug, singular_noun, plural_noun } }. Free.",
        "verb": "GET",
        "path": "/v2/objects/{object}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "object"
          ],
          "properties": {
            "object": {
              "type": "string",
              "description": "Object id or api_slug, e.g. 'companies'"
            }
          }
        },
        "options": {
          "object": {
            "method": "listObjects",
            "labelKey": "plural_noun",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "createObject",
        "label": "Create Object",
        "description": "Create a new custom object. Body: data:{ api_slug, singular_noun, plural_noun }. Returns the created object. 1 credit.",
        "verb": "POST",
        "path": "/v2/objects",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {
              "type": "object",
              "description": "{ api_slug, singular_noun, plural_noun }"
            }
          }
        }
      },
      {
        "id": "updateObject",
        "label": "Update Object",
        "description": "Update a custom object's slug/nouns. Body: data:{ api_slug?, singular_noun?, plural_noun? }. Returns the updated object. 1 credit.",
        "verb": "PATCH",
        "path": "/v2/objects/{object}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "object",
            "data"
          ],
          "properties": {
            "object": {
              "type": "string",
              "description": "Object id or api_slug"
            },
            "data": {
              "type": "object",
              "description": "{ api_slug?, singular_noun?, plural_noun? }"
            }
          }
        },
        "options": {
          "object": {
            "method": "listObjects",
            "labelKey": "plural_noun",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "queryRecords",
        "label": "Query Records",
        "description": "List/filter/sort records of an object (people, companies, deals, or custom). Body: { filter?, filter_view_id?, sorts?:[{ attribute, direction:'asc'|'desc', field? }], limit? (max 500), offset? }. Returns { data:[{ id:{ record_id, object_id }, web_url, created_at, values }] }. Filter shape: { attribute_slug: value } or { '$or':[...] }. Free.",
        "verb": "POST",
        "path": "/v2/objects/{object}/records/query",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "object"
          ],
          "properties": {
            "object": {
              "type": "string",
              "description": "Object id or api_slug, e.g. 'companies'"
            },
            "filter": {
              "type": "object",
              "description": "Attribute filter, e.g. { name: { '$contains': 'Stripe' } }"
            },
            "filter_view_id": {
              "type": "string",
              "description": "Use a saved view's filter instead of an inline filter"
            },
            "sorts": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "[{ attribute, direction:'asc'|'desc', field? }]"
            },
            "limit": {
              "type": "integer",
              "description": "Max records (default 500)"
            },
            "offset": {
              "type": "integer",
              "description": "Pagination offset (default 0)"
            }
          }
        },
        "options": {
          "object": {
            "method": "listObjects",
            "labelKey": "plural_noun",
            "valueKey": "api_slug"
          }
        },
        "rateLimit": {
          "rps": 5
        }
      },
      {
        "id": "searchRecords",
        "label": "Search Records (Fuzzy)",
        "description": "Fuzzy full-text search for records across one or more objects. Body: { query, objects?:['people','companies'], limit? }. Returns matching records ranked by relevance. Free.",
        "verb": "POST",
        "path": "/v2/objects/records/search",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "query"
          ],
          "properties": {
            "query": {
              "type": "string",
              "description": "Free-text search term"
            },
            "objects": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Object slugs to search, e.g. ['people','companies']"
            },
            "limit": {
              "type": "integer",
              "description": "Max results"
            }
          }
        }
      },
      {
        "id": "getRecord",
        "label": "Get Record",
        "description": "Get a single record by object + record_id, with all its current attribute values. Returns { data:{ id:{ record_id, object_id }, web_url, created_at, values } }. Free.",
        "verb": "GET",
        "path": "/v2/objects/{object}/records/{record_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "object",
            "record_id"
          ],
          "properties": {
            "object": {
              "type": "string",
              "description": "Object id or api_slug"
            },
            "record_id": {
              "type": "string",
              "description": "Record UUID"
            }
          }
        },
        "options": {
          "object": {
            "method": "listObjects",
            "labelKey": "plural_noun",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "createRecord",
        "label": "Create Record",
        "description": "Create a new record (person, company, deal, or custom). Body: { data:{ values:{ attribute_slug: value | [values] } } }. Throws on conflicts of unique attributes — use assertRecord to upsert instead. Returns the created record. 1 credit.",
        "verb": "POST",
        "path": "/v2/objects/{object}/records",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "object",
            "data"
          ],
          "properties": {
            "object": {
              "type": "string",
              "description": "Object id or api_slug, e.g. 'companies'"
            },
            "data": {
              "type": "object",
              "description": "{ values: { attribute_slug: value, ... } }"
            }
          }
        },
        "options": {
          "object": {
            "method": "listObjects",
            "labelKey": "plural_noun",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "assertRecord",
        "label": "Assert (Upsert) Record",
        "description": "Create OR update a record matched by a single attribute. Query param matching_attribute = the slug/id used to find an existing record (e.g. 'domains' for companies, 'email_addresses' for people). If a record matches, it is updated; otherwise created. Body: { data:{ values:{...} } }. Returns the asserted record. 1 credit.",
        "verb": "PUT",
        "path": "/v2/objects/{object}/records",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "object",
            "data"
          ],
          "properties": {
            "object": {
              "type": "string",
              "description": "Object id or api_slug"
            },
            "matching_attribute": {
              "type": "string",
              "description": "Query param — slug/id of the unique attribute used to match, e.g. 'domains'"
            },
            "data": {
              "type": "object",
              "description": "{ values: { attribute_slug: value, ... } }"
            }
          }
        },
        "options": {
          "object": {
            "method": "listObjects",
            "labelKey": "plural_noun",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "updateRecordAppend",
        "label": "Update Record (Append Multiselect)",
        "description": "Update a record by id; for multiselect attributes the supplied values are APPENDED to existing ones. Body: { data:{ values:{...} } }. Returns the updated record. 1 credit.",
        "verb": "PATCH",
        "path": "/v2/objects/{object}/records/{record_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "object",
            "record_id",
            "data"
          ],
          "properties": {
            "object": {
              "type": "string",
              "description": "Object id or api_slug"
            },
            "record_id": {
              "type": "string",
              "description": "Record UUID"
            },
            "data": {
              "type": "object",
              "description": "{ values: { attribute_slug: value, ... } }"
            }
          }
        },
        "options": {
          "object": {
            "method": "listObjects",
            "labelKey": "plural_noun",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "updateRecordOverwrite",
        "label": "Update Record (Overwrite Multiselect)",
        "description": "Update a record by id; for multiselect attributes the supplied values OVERWRITE (replace) existing ones. Body: { data:{ values:{...} } }. Returns the updated record. 1 credit.",
        "verb": "PUT",
        "path": "/v2/objects/{object}/records/{record_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "object",
            "record_id",
            "data"
          ],
          "properties": {
            "object": {
              "type": "string",
              "description": "Object id or api_slug"
            },
            "record_id": {
              "type": "string",
              "description": "Record UUID"
            },
            "data": {
              "type": "object",
              "description": "{ values: { attribute_slug: value, ... } }"
            }
          }
        },
        "options": {
          "object": {
            "method": "listObjects",
            "labelKey": "plural_noun",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "deleteRecord",
        "label": "Delete Record",
        "description": "Permanently delete a record by object + record_id. Returns {} on success. 1 credit.",
        "verb": "DELETE",
        "path": "/v2/objects/{object}/records/{record_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "object",
            "record_id"
          ],
          "properties": {
            "object": {
              "type": "string",
              "description": "Object id or api_slug"
            },
            "record_id": {
              "type": "string",
              "description": "Record UUID"
            }
          }
        },
        "options": {
          "object": {
            "method": "listObjects",
            "labelKey": "plural_noun",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "listRecordAttributeValues",
        "label": "List Record Attribute Values",
        "description": "List the historical/current values of one attribute on a record (e.g. the full history of a company's 'name'). Returns { data:[{ active_from, active_until, value }] }. Free.",
        "verb": "GET",
        "path": "/v2/objects/{object}/records/{record_id}/attributes/{attribute}/values",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "object",
            "record_id",
            "attribute"
          ],
          "properties": {
            "object": {
              "type": "string",
              "description": "Object id or api_slug"
            },
            "record_id": {
              "type": "string",
              "description": "Record UUID"
            },
            "attribute": {
              "type": "string",
              "description": "Attribute id or slug"
            },
            "limit": {
              "type": "integer"
            },
            "offset": {
              "type": "integer"
            }
          }
        },
        "options": {
          "object": {
            "method": "listObjects",
            "labelKey": "plural_noun",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "listRecordEntries",
        "label": "List Record's List Entries",
        "description": "List all list entries that reference a given record — i.e. which lists this record belongs to. Returns { data:[{ list_id, entry_id, ... }] }. Free.",
        "verb": "GET",
        "path": "/v2/objects/{object}/records/{record_id}/entries",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "object",
            "record_id"
          ],
          "properties": {
            "object": {
              "type": "string",
              "description": "Object id or api_slug"
            },
            "record_id": {
              "type": "string",
              "description": "Record UUID"
            },
            "limit": {
              "type": "integer"
            },
            "offset": {
              "type": "integer"
            }
          }
        },
        "options": {
          "object": {
            "method": "listObjects",
            "labelKey": "plural_noun",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "listAttributes",
        "label": "List Attributes",
        "description": "List all attributes defined on an object or list. target = 'objects' or 'lists'; identifier = the object/list slug or id. Returns { data:[{ id, api_slug, title, type, is_unique, is_multiselect, is_required }] }. Free.",
        "verb": "GET",
        "path": "/v2/{target}/{identifier}/attributes",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "target",
            "identifier"
          ],
          "properties": {
            "target": {
              "type": "string",
              "description": "'objects' or 'lists'"
            },
            "identifier": {
              "type": "string",
              "description": "Object/list slug or id, e.g. 'companies'"
            },
            "limit": {
              "type": "integer"
            },
            "offset": {
              "type": "integer"
            }
          }
        }
      },
      {
        "id": "getAttribute",
        "label": "Get Attribute",
        "description": "Get a single attribute's config by id or slug on an object or list. target = 'objects'|'lists'. Returns { data:{ id, api_slug, title, type, is_unique, is_multiselect } }. Free.",
        "verb": "GET",
        "path": "/v2/{target}/{identifier}/attributes/{attribute}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "target",
            "identifier",
            "attribute"
          ],
          "properties": {
            "target": {
              "type": "string",
              "description": "'objects' or 'lists'"
            },
            "identifier": {
              "type": "string",
              "description": "Object/list slug or id"
            },
            "attribute": {
              "type": "string",
              "description": "Attribute id or slug"
            }
          }
        }
      },
      {
        "id": "createAttribute",
        "label": "Create Attribute",
        "description": "Create a new attribute (custom field) on an object or list. Body: data:{ title, api_slug, type, is_required, is_unique, is_multiselect, ... }. type one of: text, number, checkbox, currency, date, timestamp, rating, status, select, record-reference, actor-reference, location, domain, email-address, phone-number, personal-name. Returns the created attribute. 1 credit.",
        "verb": "POST",
        "path": "/v2/{target}/{identifier}/attributes",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "target",
            "identifier",
            "data"
          ],
          "properties": {
            "target": {
              "type": "string",
              "description": "'objects' or 'lists'"
            },
            "identifier": {
              "type": "string",
              "description": "Object/list slug or id"
            },
            "data": {
              "type": "object",
              "description": "{ title, api_slug, type, is_required, is_unique, is_multiselect, ... }"
            }
          }
        }
      },
      {
        "id": "updateAttribute",
        "label": "Update Attribute",
        "description": "Update an attribute's config (title, description, required/unique flags, etc.) on an object or list. Body: data:{ ... }. Returns the updated attribute. 1 credit.",
        "verb": "PATCH",
        "path": "/v2/{target}/{identifier}/attributes/{attribute}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "target",
            "identifier",
            "attribute",
            "data"
          ],
          "properties": {
            "target": {
              "type": "string",
              "description": "'objects' or 'lists'"
            },
            "identifier": {
              "type": "string",
              "description": "Object/list slug or id"
            },
            "attribute": {
              "type": "string",
              "description": "Attribute id or slug"
            },
            "data": {
              "type": "object",
              "description": "Fields to update"
            }
          }
        }
      },
      {
        "id": "listSelectOptions",
        "label": "List Select Options",
        "description": "List the select options for a select-type attribute on an object or list. Returns { data:[{ id, title, is_archived }] }. Free.",
        "verb": "GET",
        "path": "/v2/{target}/{identifier}/attributes/{attribute}/options",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "target",
            "identifier",
            "attribute"
          ],
          "properties": {
            "target": {
              "type": "string",
              "description": "'objects' or 'lists'"
            },
            "identifier": {
              "type": "string",
              "description": "Object/list slug or id"
            },
            "attribute": {
              "type": "string",
              "description": "Select attribute id or slug"
            }
          }
        }
      },
      {
        "id": "createSelectOption",
        "label": "Create Select Option",
        "description": "Add a new option to a select-type attribute. Body: data:{ title }. Returns the created option. 1 credit.",
        "verb": "POST",
        "path": "/v2/{target}/{identifier}/attributes/{attribute}/options",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "target",
            "identifier",
            "attribute",
            "data"
          ],
          "properties": {
            "target": {
              "type": "string",
              "description": "'objects' or 'lists'"
            },
            "identifier": {
              "type": "string",
              "description": "Object/list slug or id"
            },
            "attribute": {
              "type": "string",
              "description": "Select attribute id or slug"
            },
            "data": {
              "type": "object",
              "description": "{ title }"
            }
          }
        }
      },
      {
        "id": "updateSelectOption",
        "label": "Update Select Option",
        "description": "Update or archive a select option. Body: data:{ title?, is_archived? }. Returns the updated option. 1 credit.",
        "verb": "PATCH",
        "path": "/v2/{target}/{identifier}/attributes/{attribute}/options/{option}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "target",
            "identifier",
            "attribute",
            "option",
            "data"
          ],
          "properties": {
            "target": {
              "type": "string",
              "description": "'objects' or 'lists'"
            },
            "identifier": {
              "type": "string",
              "description": "Object/list slug or id"
            },
            "attribute": {
              "type": "string",
              "description": "Select attribute id or slug"
            },
            "option": {
              "type": "string",
              "description": "Option id"
            },
            "data": {
              "type": "object",
              "description": "{ title?, is_archived? }"
            }
          }
        }
      },
      {
        "id": "listStatuses",
        "label": "List Statuses",
        "description": "List the statuses for a status-type attribute (e.g. a deal's 'stage'). Returns { data:[{ id, title, is_archived, celebration_enabled }] }. Free.",
        "verb": "GET",
        "path": "/v2/{target}/{identifier}/attributes/{attribute}/statuses",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "target",
            "identifier",
            "attribute"
          ],
          "properties": {
            "target": {
              "type": "string",
              "description": "'objects' or 'lists'"
            },
            "identifier": {
              "type": "string",
              "description": "Object/list slug or id"
            },
            "attribute": {
              "type": "string",
              "description": "Status attribute id or slug"
            }
          }
        }
      },
      {
        "id": "createStatus",
        "label": "Create Status",
        "description": "Add a new status to a status-type attribute. Body: data:{ title, celebration_enabled?, target_time_in_status? }. Returns the created status. 1 credit.",
        "verb": "POST",
        "path": "/v2/{target}/{identifier}/attributes/{attribute}/statuses",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "target",
            "identifier",
            "attribute",
            "data"
          ],
          "properties": {
            "target": {
              "type": "string",
              "description": "'objects' or 'lists'"
            },
            "identifier": {
              "type": "string",
              "description": "Object/list slug or id"
            },
            "attribute": {
              "type": "string",
              "description": "Status attribute id or slug"
            },
            "data": {
              "type": "object",
              "description": "{ title, celebration_enabled?, target_time_in_status? }"
            }
          }
        }
      },
      {
        "id": "updateStatus",
        "label": "Update Status",
        "description": "Update or archive a status on a status-type attribute. Body: data:{ title?, is_archived?, celebration_enabled? }. Returns the updated status. 1 credit.",
        "verb": "PATCH",
        "path": "/v2/{target}/{identifier}/attributes/{attribute}/statuses/{status}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "target",
            "identifier",
            "attribute",
            "status",
            "data"
          ],
          "properties": {
            "target": {
              "type": "string",
              "description": "'objects' or 'lists'"
            },
            "identifier": {
              "type": "string",
              "description": "Object/list slug or id"
            },
            "attribute": {
              "type": "string",
              "description": "Status attribute id or slug"
            },
            "status": {
              "type": "string",
              "description": "Status id"
            },
            "data": {
              "type": "object",
              "description": "{ title?, is_archived?, celebration_enabled? }"
            }
          }
        }
      },
      {
        "id": "listLists",
        "label": "List All Lists",
        "description": "List all lists in the workspace (e.g. 'Sales Pipeline', 'Newsletter'). Returns { data:[{ id:{ list_id }, api_slug, name, parent_object, workspace_access }] }. No inputs. Free.",
        "verb": "GET",
        "path": "/v2/lists",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "getList",
        "label": "Get List",
        "description": "Get a single list's config by id or api_slug. Returns { data:{ id, api_slug, name, parent_object } }. Free.",
        "verb": "GET",
        "path": "/v2/lists/{list}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "list"
          ],
          "properties": {
            "list": {
              "type": "string",
              "description": "List id or api_slug"
            }
          }
        },
        "options": {
          "list": {
            "method": "listLists",
            "labelKey": "name",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "createList",
        "label": "Create List",
        "description": "Create a new list. Body: data:{ name, api_slug, parent_object, workspace_access, workspace_member_access? }. parent_object is the object slug whose records this list holds (e.g. 'people'). Returns the created list. 1 credit.",
        "verb": "POST",
        "path": "/v2/lists",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {
              "type": "object",
              "description": "{ name, api_slug, parent_object, workspace_access, ... }"
            }
          }
        }
      },
      {
        "id": "updateList",
        "label": "Update List",
        "description": "Update a list's name, slug or access. Body: data:{ name?, api_slug?, workspace_access? }. Returns the updated list. 1 credit.",
        "verb": "PATCH",
        "path": "/v2/lists/{list}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "list",
            "data"
          ],
          "properties": {
            "list": {
              "type": "string",
              "description": "List id or api_slug"
            },
            "data": {
              "type": "object",
              "description": "{ name?, api_slug?, workspace_access? }"
            }
          }
        },
        "options": {
          "list": {
            "method": "listLists",
            "labelKey": "name",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "queryListEntries",
        "label": "Query List Entries",
        "description": "List/filter/sort entries in a list. Body: { filter?, sorts?, limit? (max 500), offset? }. Returns { data:[{ id:{ entry_id, list_id }, parent_record_id, parent_object, entry_values }] }. Free.",
        "verb": "POST",
        "path": "/v2/lists/{list}/entries/query",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "list"
          ],
          "properties": {
            "list": {
              "type": "string",
              "description": "List id or api_slug"
            },
            "filter": {
              "type": "object",
              "description": "Entry/parent-record filter"
            },
            "sorts": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "limit": {
              "type": "integer",
              "description": "Max entries (default 500)"
            },
            "offset": {
              "type": "integer"
            }
          }
        },
        "options": {
          "list": {
            "method": "listLists",
            "labelKey": "name",
            "valueKey": "api_slug"
          }
        },
        "rateLimit": {
          "rps": 5
        }
      },
      {
        "id": "createListEntry",
        "label": "Create List Entry (Add Record to List)",
        "description": "Add an existing record to a list as a new entry, optionally setting list-specific attribute values. Body: { data:{ parent_record_id, parent_object, entry_values:{ list_attr_slug: value } } }. Returns the created entry. 1 credit.",
        "verb": "POST",
        "path": "/v2/lists/{list}/entries",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "list",
            "data"
          ],
          "properties": {
            "list": {
              "type": "string",
              "description": "List id or api_slug"
            },
            "data": {
              "type": "object",
              "description": "{ parent_record_id, parent_object, entry_values:{...} }"
            }
          }
        },
        "options": {
          "list": {
            "method": "listLists",
            "labelKey": "name",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "assertListEntryByParent",
        "label": "Assert List Entry by Parent",
        "description": "Upsert a list entry keyed by its parent record: if the record is already in the list its entry_values are updated, otherwise a new entry is added. Body: { data:{ parent_record_id, parent_object, entry_values:{...} } }. Returns the entry. 1 credit.",
        "verb": "PUT",
        "path": "/v2/lists/{list}/entries",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "list",
            "data"
          ],
          "properties": {
            "list": {
              "type": "string",
              "description": "List id or api_slug"
            },
            "data": {
              "type": "object",
              "description": "{ parent_record_id, parent_object, entry_values:{...} }"
            }
          }
        },
        "options": {
          "list": {
            "method": "listLists",
            "labelKey": "name",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "getListEntry",
        "label": "Get List Entry",
        "description": "Get a single list entry by list + entry_id, with its entry_values and parent record reference. Free.",
        "verb": "GET",
        "path": "/v2/lists/{list}/entries/{entry_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "list",
            "entry_id"
          ],
          "properties": {
            "list": {
              "type": "string",
              "description": "List id or api_slug"
            },
            "entry_id": {
              "type": "string",
              "description": "Entry UUID"
            }
          }
        },
        "options": {
          "list": {
            "method": "listLists",
            "labelKey": "name",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "updateListEntryAppend",
        "label": "Update List Entry (Append Multiselect)",
        "description": "Update an entry's list-attribute values; multiselect values are APPENDED. Body: { data:{ entry_values:{...} } }. Returns the updated entry. 1 credit.",
        "verb": "PATCH",
        "path": "/v2/lists/{list}/entries/{entry_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "list",
            "entry_id",
            "data"
          ],
          "properties": {
            "list": {
              "type": "string",
              "description": "List id or api_slug"
            },
            "entry_id": {
              "type": "string",
              "description": "Entry UUID"
            },
            "data": {
              "type": "object",
              "description": "{ entry_values:{...} }"
            }
          }
        },
        "options": {
          "list": {
            "method": "listLists",
            "labelKey": "name",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "updateListEntryOverwrite",
        "label": "Update List Entry (Overwrite Multiselect)",
        "description": "Update an entry's list-attribute values; multiselect values OVERWRITE existing ones. Body: { data:{ entry_values:{...} } }. Returns the updated entry. 1 credit.",
        "verb": "PUT",
        "path": "/v2/lists/{list}/entries/{entry_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "list",
            "entry_id",
            "data"
          ],
          "properties": {
            "list": {
              "type": "string",
              "description": "List id or api_slug"
            },
            "entry_id": {
              "type": "string",
              "description": "Entry UUID"
            },
            "data": {
              "type": "object",
              "description": "{ entry_values:{...} }"
            }
          }
        },
        "options": {
          "list": {
            "method": "listLists",
            "labelKey": "name",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "deleteListEntry",
        "label": "Delete List Entry (Remove from List)",
        "description": "Remove a record from a list by deleting its entry (the underlying record is NOT deleted). Returns {} on success. 1 credit.",
        "verb": "DELETE",
        "path": "/v2/lists/{list}/entries/{entry_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "list",
            "entry_id"
          ],
          "properties": {
            "list": {
              "type": "string",
              "description": "List id or api_slug"
            },
            "entry_id": {
              "type": "string",
              "description": "Entry UUID"
            }
          }
        },
        "options": {
          "list": {
            "method": "listLists",
            "labelKey": "name",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "listListEntryAttributeValues",
        "label": "List Entry Attribute Values",
        "description": "List the historical/current values of one list-attribute on a list entry. Returns { data:[{ active_from, active_until, value }] }. Free.",
        "verb": "GET",
        "path": "/v2/lists/{list}/entries/{entry_id}/attributes/{attribute}/values",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "list",
            "entry_id",
            "attribute"
          ],
          "properties": {
            "list": {
              "type": "string",
              "description": "List id or api_slug"
            },
            "entry_id": {
              "type": "string",
              "description": "Entry UUID"
            },
            "attribute": {
              "type": "string",
              "description": "List attribute id or slug"
            },
            "limit": {
              "type": "integer"
            },
            "offset": {
              "type": "integer"
            }
          }
        },
        "options": {
          "list": {
            "method": "listLists",
            "labelKey": "name",
            "valueKey": "api_slug"
          }
        }
      },
      {
        "id": "listNotes",
        "label": "List Notes",
        "description": "List notes, optionally filtered to a parent record. Query params: parent_object?, parent_record_id?, limit?, offset?. Returns { data:[{ id:{ note_id }, parent_object, parent_record_id, title, content_plaintext, created_at, created_by_actor }] }. Free.",
        "verb": "GET",
        "path": "/v2/notes",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "parent_object": {
              "type": "string",
              "description": "Filter to notes on this object slug"
            },
            "parent_record_id": {
              "type": "string",
              "description": "Filter to notes on this record"
            },
            "limit": {
              "type": "integer"
            },
            "offset": {
              "type": "integer"
            }
          }
        }
      },
      {
        "id": "getNote",
        "label": "Get Note",
        "description": "Get a single note by id, including its full content. Free.",
        "verb": "GET",
        "path": "/v2/notes/{note_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "note_id"
          ],
          "properties": {
            "note_id": {
              "type": "string",
              "description": "Note UUID"
            }
          }
        }
      },
      {
        "id": "createNote",
        "label": "Create Note",
        "description": "Create a note attached to a record. Body: data:{ parent_object, parent_record_id, title, format:'plaintext'|'markdown', content, created_at?, meeting_id? }. Returns the created note. 1 credit.",
        "verb": "POST",
        "path": "/v2/notes",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {
              "type": "object",
              "description": "{ parent_object, parent_record_id, title, format:'plaintext'|'markdown', content }"
            }
          }
        }
      },
      {
        "id": "deleteNote",
        "label": "Delete Note",
        "description": "Permanently delete a note by id. Returns {} on success. 1 credit.",
        "verb": "DELETE",
        "path": "/v2/notes/{note_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "note_id"
          ],
          "properties": {
            "note_id": {
              "type": "string",
              "description": "Note UUID"
            }
          }
        }
      },
      {
        "id": "listTasks",
        "label": "List Tasks",
        "description": "List tasks (oldest first), optionally filtered. Query params: limit?, offset?, sort?, linked_object?, linked_record_id?, assignee?, is_completed?. Returns { data:[{ id:{ task_id }, content_plaintext, is_completed, deadline_at, linked_records, assignees, created_at }] }. Free.",
        "verb": "GET",
        "path": "/v2/tasks",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer"
            },
            "offset": {
              "type": "integer"
            },
            "sort": {
              "type": "string",
              "description": "e.g. 'created_at:asc'"
            },
            "linked_object": {
              "type": "string",
              "description": "Filter to tasks linked to this object"
            },
            "linked_record_id": {
              "type": "string",
              "description": "Filter to tasks linked to this record"
            },
            "assignee": {
              "type": "string",
              "description": "Workspace member id"
            },
            "is_completed": {
              "type": "boolean"
            }
          }
        },
        "options": {
          "assignee": {
            "method": "listWorkspaceMembers",
            "labelKey": "email_address",
            "valueKey": "email_address"
          }
        }
      },
      {
        "id": "getTask",
        "label": "Get Task",
        "description": "Get a single task by id, with content, deadline, assignees and linked records. Free.",
        "verb": "GET",
        "path": "/v2/tasks/{task_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "task_id"
          ],
          "properties": {
            "task_id": {
              "type": "string",
              "description": "Task UUID"
            }
          }
        }
      },
      {
        "id": "createTask",
        "label": "Create Task",
        "description": "Create a task. Body: data:{ content, format:'plaintext', deadline_at?, is_completed?, linked_records?:[{ target_object, target_record_id }], assignees?:[{ referenced_actor_type:'workspace-member', referenced_actor_id }] }. Returns the created task. 1 credit.",
        "verb": "POST",
        "path": "/v2/tasks",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {
              "type": "object",
              "description": "{ content, format:'plaintext', deadline_at?, linked_records?, assignees? }"
            }
          }
        }
      },
      {
        "id": "updateTask",
        "label": "Update Task",
        "description": "Update a task's completion, deadline, assignees or linked records. Body: data:{ is_completed?, deadline_at?, assignees?, linked_records? }. Returns the updated task. 1 credit.",
        "verb": "PATCH",
        "path": "/v2/tasks/{task_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "task_id",
            "data"
          ],
          "properties": {
            "task_id": {
              "type": "string",
              "description": "Task UUID"
            },
            "data": {
              "type": "object",
              "description": "{ is_completed?, deadline_at?, assignees?, linked_records? }"
            }
          }
        }
      },
      {
        "id": "deleteTask",
        "label": "Delete Task",
        "description": "Permanently delete a task by id. Returns {} on success. 1 credit.",
        "verb": "DELETE",
        "path": "/v2/tasks/{task_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "task_id"
          ],
          "properties": {
            "task_id": {
              "type": "string",
              "description": "Task UUID"
            }
          }
        }
      },
      {
        "id": "listThreads",
        "label": "List Threads",
        "description": "List comment threads, optionally scoped to a record or list entry. Query params: record_id?, object?, entry_id?, list?, limit?, offset?. Returns { data:[{ id:{ thread_id }, comments[] }] }. Free.",
        "verb": "GET",
        "path": "/v2/threads",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "record_id": {
              "type": "string",
              "description": "Scope to a record"
            },
            "object": {
              "type": "string",
              "description": "Object slug (with record_id)"
            },
            "entry_id": {
              "type": "string",
              "description": "Scope to a list entry"
            },
            "list": {
              "type": "string",
              "description": "List id/slug (with entry_id)"
            },
            "limit": {
              "type": "integer"
            },
            "offset": {
              "type": "integer"
            }
          }
        }
      },
      {
        "id": "getThread",
        "label": "Get Thread",
        "description": "Get a single comment thread by id, including all comments in order. Free.",
        "verb": "GET",
        "path": "/v2/threads/{thread_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "thread_id"
          ],
          "properties": {
            "thread_id": {
              "type": "string",
              "description": "Thread UUID"
            }
          }
        }
      },
      {
        "id": "createComment",
        "label": "Create Comment",
        "description": "Create a comment, either starting a new thread on a record/entry or replying to an existing thread. Body: data:{ format:'plaintext', content, author:{ type:'workspace-member', id }, thread_id? (to reply) OR record:{ object, record_id } / entry:{ list, entry_id } (to start). Returns the created comment. 1 credit.",
        "verb": "POST",
        "path": "/v2/comments",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {
              "type": "object",
              "description": "{ format:'plaintext', content, author, thread_id? | record? | entry? }"
            }
          }
        }
      },
      {
        "id": "getComment",
        "label": "Get Comment",
        "description": "Get a single comment by id, with its content, author and thread. Free.",
        "verb": "GET",
        "path": "/v2/comments/{comment_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "comment_id"
          ],
          "properties": {
            "comment_id": {
              "type": "string",
              "description": "Comment UUID"
            }
          }
        }
      },
      {
        "id": "deleteComment",
        "label": "Delete Comment",
        "description": "Permanently delete a comment by id. Returns {} on success. 1 credit.",
        "verb": "DELETE",
        "path": "/v2/comments/{comment_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "comment_id"
          ],
          "properties": {
            "comment_id": {
              "type": "string",
              "description": "Comment UUID"
            }
          }
        }
      },
      {
        "id": "listWorkspaceMembers",
        "label": "List Workspace Members",
        "description": "List all members of the workspace (used to resolve assignees and comment authors). Returns { data:[{ id:{ workspace_member_id }, first_name, last_name, email_address, access_level }] }. No inputs. Free.",
        "verb": "GET",
        "path": "/v2/workspace_members",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "getWorkspaceMember",
        "label": "Get Workspace Member",
        "description": "Get a single workspace member by id. Returns { data:{ first_name, last_name, email_address, access_level } }. Free.",
        "verb": "GET",
        "path": "/v2/workspace_members/{workspace_member_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_member_id"
          ],
          "properties": {
            "workspace_member_id": {
              "type": "string",
              "description": "Workspace member UUID"
            }
          }
        },
        "options": {
          "workspace_member_id": {
            "method": "listWorkspaceMembers",
            "labelKey": "email_address",
            "valueKey": "email_address"
          }
        }
      },
      {
        "id": "listWebhooks",
        "label": "List Webhooks",
        "description": "List all webhooks configured in the workspace. Query params: limit?, offset?. Returns { data:[{ id:{ webhook_id }, target_url, subscriptions, status }] }. Free.",
        "verb": "GET",
        "path": "/v2/webhooks",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer"
            },
            "offset": {
              "type": "integer"
            }
          }
        }
      },
      {
        "id": "getWebhook",
        "label": "Get Webhook",
        "description": "Get a single webhook by id, including its event subscriptions and status. Free.",
        "verb": "GET",
        "path": "/v2/webhooks/{webhook_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "webhook_id"
          ],
          "properties": {
            "webhook_id": {
              "type": "string",
              "description": "Webhook UUID"
            }
          }
        }
      },
      {
        "id": "createWebhook",
        "label": "Create Webhook",
        "description": "Create a webhook. Body: data:{ target_url, subscriptions:[{ event_type, filter? }] }. event_type examples: 'record.created', 'record.updated', 'record.deleted', 'list-entry.created', 'note.created', 'task.created', 'comment.created'. Returns the webhook incl. signing secret. 1 credit.",
        "verb": "POST",
        "path": "/v2/webhooks",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {
              "type": "object",
              "description": "{ target_url, subscriptions:[{ event_type, filter? }] }"
            }
          }
        }
      },
      {
        "id": "updateWebhook",
        "label": "Update Webhook",
        "description": "Update a webhook's target URL or subscriptions. Body: data:{ target_url?, subscriptions? }. Returns the updated webhook. 1 credit.",
        "verb": "PATCH",
        "path": "/v2/webhooks/{webhook_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "webhook_id",
            "data"
          ],
          "properties": {
            "webhook_id": {
              "type": "string",
              "description": "Webhook UUID"
            },
            "data": {
              "type": "object",
              "description": "{ target_url?, subscriptions? }"
            }
          }
        }
      },
      {
        "id": "deleteWebhook",
        "label": "Delete Webhook",
        "description": "Permanently delete a webhook by id. Returns {} on success. 1 credit.",
        "verb": "DELETE",
        "path": "/v2/webhooks/{webhook_id}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "webhook_id"
          ],
          "properties": {
            "webhook_id": {
              "type": "string",
              "description": "Webhook UUID"
            }
          }
        }
      }
    ]
  },
  {
    "id": "avtrz",
    "name": "Avtrz",
    "version": "1.0.0",
    "category": "enrichment",
    "description": "Profile-photo enrichment — resolve a person's real LinkedIn avatar image from their profile URL or handle.",
    "baseUrl": "https://www.avtrz.dev/v1",
    "logo": "https://www.google.com/s2/favicons?domain=avtrz.dev&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "x-api-key",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 120,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "getAvatar",
        "label": "Get Avatar",
        "description": "Resolve a person's profile photo from their LinkedIn URL or handle. Provide `linkedin_url` OR `username` (the slug after /in/). Returns the resolved CDN image URL (or empty if no photo was found). Use a secret 'sk_' key.",
        "verb": "GET",
        "path": "/avatar",
        "credits": 1,
        "rateLimit": {
          "rps": 2
        },
        "input": {
          "type": "object",
          "properties": {
            "linkedin_url": {
              "type": "string",
              "description": "Full LinkedIn profile URL"
            },
            "username": {
              "type": "string",
              "description": "LinkedIn handle (the part after /in/)"
            },
            "size": {
              "type": "integer",
              "description": "32 | 64 | 128 | 256 | 512 (default 128)"
            }
          }
        },
        "category": "Enrich people"
      }
    ]
  },
  {
    "id": "bettercontact",
    "name": "BetterContact",
    "version": "1.0.0",
    "category": "enrichment",
    "description": "Waterfall email & phone enrichment across 20+ providers. Async: enrich, then poll for the result.",
    "baseUrl": "https://app.bettercontact.rocks/api/v2",
    "logo": "https://www.google.com/s2/favicons?domain=bettercontact.rocks&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "X-API-Key",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 60
    },
    "methods": [
      {
        "id": "enrich",
        "label": "Enrich (submit)",
        "description": "Submit up to 100 leads for waterfall email/phone enrichment. `data` is an array of leads, each with first_name, last_name, company, company_domain, linkedin_url (and optional custom_fields). Set enrich_email_address and/or enrich_phone_number. Returns { success, id } where `id` is the request id — poll Get Result with it. ASYNC: results are not ready immediately.",
        "verb": "POST",
        "path": "/async",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {
              "type": "array",
              "description": "Array of leads (1-100). Each: { first_name, last_name, company, company_domain, linkedin_url, custom_fields }",
              "items": {
                "type": "object"
              }
            },
            "enrich_email_address": {
              "type": "boolean",
              "description": "Find a verified work email (default true)"
            },
            "enrich_phone_number": {
              "type": "boolean",
              "description": "Find a direct phone number"
            },
            "webhook": {
              "type": "string",
              "description": "Optional webhook URL POSTed when enrichment finishes"
            }
          }
        },
        "category": "Find email"
      },
      {
        "id": "getResult",
        "label": "Get Result (poll)",
        "description": "Fetch enrichment results by request id (the `id` from Enrich). Returns { id, status, credits_consumed, credits_left, data[] } where status is 'pending' until done then 'terminated'. Each data item has contact_email_address, contact_email_address_status, contact_phone_number, contact_job_title, etc.",
        "verb": "GET",
        "path": "/async/{request_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "request_id"
          ],
          "properties": {
            "request_id": {
              "type": "string",
              "description": "The id returned by Enrich"
            }
          }
        },
        "category": "Find email"
      },
      {
        "id": "findLeads",
        "label": "Find Leads (submit)",
        "description": "Submit a People/Company search to discover net-new leads (no input list). `filters` carries company criteria (company domains, company_industry, company_technology, company_headcount_min/max) and people criteria (lead_fullname, lead_linkedin_url, lead_department, lead_function, lead_skills, lead_job_title [+exact_match], lead_location, lead_seniority) — each an { include:[...], exclude:[...] } object. Returns { success, message, request_id } — poll Get Found Leads with request_id. ASYNC: results are not ready immediately.",
        "verb": "POST",
        "path": "/lead_finder/async",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "filters"
          ],
          "properties": {
            "filters": {
              "type": "object",
              "description": "Company + people filter object (see description). Each people field is { include:[...], exclude:[...] }."
            },
            "limit": {
              "type": "integer",
              "description": "Leads to return, 1-200 (default 100)"
            },
            "offset": {
              "type": "integer",
              "description": "Pagination offset; increase to page through results"
            },
            "webhook": {
              "type": "string",
              "description": "Optional webhook URL POSTed when the search finishes"
            }
          }
        },
        "category": "Find leads"
      },
      {
        "id": "getFoundLeads",
        "label": "Get Found Leads (poll)",
        "description": "Fetch lead-finder results by request id (the `request_id` from Find Leads). Returns { id, status, credits_consumed, credits_left, summary:{ leads_found }, leads[] } where status is 'pending' until done then 'terminated'. Each lead has contact (name, job_title, seniority, linkedin_url, location, email, phone) + company (name, domain, industry, headcount, hq, founded) fields. Do NOT poll this with an Enrich id — use Get Result for those.",
        "verb": "GET",
        "path": "/lead_finder/async/{request_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "request_id"
          ],
          "properties": {
            "request_id": {
              "type": "string",
              "description": "The request_id returned by Find Leads"
            }
          }
        },
        "category": "Find leads"
      },
      {
        "id": "checkCredits",
        "label": "Check Credits",
        "description": "Get the remaining credit balance for the account. Requires the account `email` as a query param (alongside the API key). Returns { success, credits_left, email }. Free — call before large enrichment or lead-finder batches.",
        "verb": "GET",
        "path": "/account",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "The account email (query param)"
            }
          }
        },
        "category": "Account"
      }
    ]
  },
  {
    "id": "exa",
    "name": "Exa",
    "version": "1.0.0",
    "category": "research",
    "description": "Neural web search & content retrieval — search, get page contents, find similar pages, and get cited answers.",
    "baseUrl": "https://api.exa.ai",
    "logo": "https://www.google.com/s2/favicons?domain=exa.ai&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "x-api-key",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rps": 10,
      "concurrency": 5
    },
    "methods": [
      {
        "id": "search",
        "label": "Search",
        "description": "Neural/keyword web search. Returns { results[] } each with url, title, score, publishedDate, author. Pass `contents: { text: true }` to also get page text/highlights/summary inline. Use `category` (company, news, people, research paper, financial report) to focus.",
        "verb": "POST",
        "path": "/search",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "query"
          ],
          "properties": {
            "query": {
              "type": "string",
              "description": "Search query"
            },
            "type": {
              "type": "string",
              "description": "auto | keyword | neural | fast (default auto)"
            },
            "category": {
              "type": "string",
              "description": "company | news | people | research paper | financial report | personal site"
            },
            "numResults": {
              "type": "integer",
              "description": "1-100 (default 10)"
            },
            "includeDomains": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "excludeDomains": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "startPublishedDate": {
              "type": "string",
              "description": "ISO 8601"
            },
            "endPublishedDate": {
              "type": "string",
              "description": "ISO 8601"
            },
            "contents": {
              "type": "object",
              "description": "e.g. { text: true, highlights: true, summary: { query: '...' } }"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "getContents",
        "label": "Get Contents",
        "description": "Fetch text / highlights / summary for given URLs (or Exa result ids). Provide `urls` (or `ids`). Returns { results[] } with text, highlights, summary.",
        "verb": "POST",
        "path": "/contents",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "urls": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "1-100 URLs (or use ids)"
            },
            "ids": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Exa result ids from /search"
            },
            "text": {
              "type": "boolean",
              "description": "Return full page text"
            },
            "highlights": {
              "type": "boolean",
              "description": "Return relevant highlights"
            },
            "summary": {
              "type": "object",
              "description": "e.g. { query: 'What does this company do?' }"
            }
          }
        },
        "category": "Scraping"
      },
      {
        "id": "findSimilar",
        "label": "Find Similar",
        "description": "Given a URL, find similar pages (e.g. similar companies). Returns { results[] }. Set excludeSourceDomain to drop the source's own domain.",
        "verb": "POST",
        "path": "/findSimilar",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "url"
          ],
          "properties": {
            "url": {
              "type": "string",
              "description": "Seed URL"
            },
            "numResults": {
              "type": "integer",
              "description": "1-100"
            },
            "excludeSourceDomain": {
              "type": "boolean"
            },
            "includeDomains": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "excludeDomains": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "contents": {
              "type": "object",
              "description": "e.g. { text: true }"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "answer",
        "label": "Answer",
        "description": "Get an LLM-generated answer to a question with web citations. Returns { answer, citations[] }. Great per-row: a question column → an answer column.",
        "verb": "POST",
        "path": "/answer",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "query"
          ],
          "properties": {
            "query": {
              "type": "string",
              "description": "The question to answer"
            },
            "text": {
              "type": "boolean",
              "description": "Include full page text in citations"
            }
          }
        },
        "category": "Search"
      }
    ]
  },
  {
    "id": "findymail",
    "name": "FindyMail",
    "version": "1.0.0",
    "category": "enrichment",
    "description": "Find verified work emails and phone numbers from names, domains or LinkedIn URLs.",
    "baseUrl": "https://app.findymail.com/api",
    "logo": "https://www.google.com/s2/favicons?domain=findymail.com&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "Authorization",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 300,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "findFromName",
        "label": "Find Email (Name + Domain)",
        "description": "Find a verified work email from a person's name and company domain. Returns { contact: { name, email, domain } }.",
        "verb": "POST",
        "path": "/search/name",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "domain"
          ],
          "properties": {
            "name": {
              "type": "string",
              "description": "Full name, e.g. 'Jane Doe'"
            },
            "domain": {
              "type": "string",
              "description": "Company domain, e.g. 'acme.com'"
            }
          }
        },
        "category": "Find email"
      },
      {
        "id": "findFromLinkedin",
        "label": "Find Email (LinkedIn URL)",
        "description": "Find a verified work email from a LinkedIn profile URL. Returns { contact: { name, email, domain, linkedin_url } }.",
        "verb": "POST",
        "path": "/search/linkedin",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "linkedin_url"
          ],
          "properties": {
            "linkedin_url": {
              "type": "string",
              "description": "Full LinkedIn profile URL"
            }
          }
        },
        "category": "Find email"
      },
      {
        "id": "findPhone",
        "label": "Find Phone",
        "description": "Find a direct phone number from a LinkedIn profile URL. Returns { phone }.",
        "verb": "POST",
        "path": "/search/phone",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "linkedin_url"
          ],
          "properties": {
            "linkedin_url": {
              "type": "string",
              "description": "Full LinkedIn profile URL"
            }
          }
        },
        "category": "Find phone",
        "rateLimit": {
          "rpm": 60,
          "concurrency": 2
        }
      },
      {
        "id": "reverseEmail",
        "label": "Reverse Email Lookup",
        "description": "Look up the person/company behind an email address. Returns { contact }.",
        "verb": "POST",
        "path": "/search/reverse-email",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Email to look up"
            }
          }
        },
        "category": "Enrich people"
      },
      {
        "id": "verify",
        "label": "Verify Email",
        "description": "Verify whether an email is deliverable. Returns { verified, provider }.",
        "verb": "POST",
        "path": "/verify",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Email to verify"
            }
          }
        },
        "category": "Verify email"
      },
      {
        "id": "credits",
        "label": "Get Credits",
        "description": "Get remaining finder + verifier credits. Returns { credits, verifier_credits }.",
        "verb": "GET",
        "path": "/credits",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "listContactLists",
        "label": "List Contact Lists",
        "description": "List the saved contact lists in your Findymail account. Returns { lists: [{ id, name }] }. Free.",
        "verb": "GET",
        "path": "/lists",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        },
        "category": "Contact lists"
      },
      {
        "id": "createContactList",
        "label": "Create Contact List",
        "description": "Create a new contact list. Input: name. Returns the created list. Free.",
        "verb": "POST",
        "path": "/lists",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string",
              "description": "Name for the new contact list"
            }
          }
        },
        "category": "Contact lists"
      },
      {
        "id": "getContacts",
        "label": "Get Contacts In List",
        "description": "Get the contacts saved in a specific list. Returns { contacts: [...] }. Free.",
        "verb": "GET",
        "path": "/lists/{id}/contacts",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Contact list id (pick by name)"
            },
            "page": {
              "type": "integer",
              "description": "Page number for pagination"
            }
          }
        },
        "options": {
          "id": {
            "method": "listContactLists",
            "itemsPath": "lists",
            "labelKey": "name",
            "valueKey": "id"
          }
        },
        "category": "Contact lists"
      }
    ]
  },
  {
    "id": "firecrawl",
    "name": "Firecrawl",
    "version": "1.0.0",
    "category": "scraping",
    "description": "Firecrawl — turn any website into clean LLM-ready data: scrape a single page to markdown/html/json, crawl whole sites, map every URL, run web search, and extract structured data across pages with an LLM, via the Firecrawl v2 REST API.",
    "logo": "https://www.google.com/s2/favicons?domain=firecrawl.dev&sz=128",
    "baseUrl": "https://api.firecrawl.dev",
    "auth": {
      "type": "apiKey",
      "header": "Authorization",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 500,
      "concurrency": 5
    },
    "methods": [
      {
        "id": "scrape",
        "label": "Scrape Page",
        "description": "Scrape a single URL and return clean content. Body: { url (required), formats:['markdown'|'html'|'rawHtml'|'links'|'summary'|'screenshot'|{type:'json',...}], onlyMainContent (default true), includeTags[], excludeTags[], waitFor (ms), timeout (ms 1000-300000, default 60000), headers{}, actions[], mobile, parsers, location, proxy }. Returns { success, data:{ markdown, html, links, screenshot, metadata{ title, description, sourceURL, statusCode } } }. Synchronous. 1 credit (more for screenshot/json).",
        "verb": "POST",
        "path": "/v2/scrape",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "url"
          ],
          "properties": {
            "url": {
              "type": "string",
              "description": "The URL to scrape"
            },
            "formats": {
              "type": "array",
              "items": {},
              "description": "Output formats, e.g. ['markdown','html','links','screenshot']; an item can be an object like { type:'json', prompt, schema }. Default ['markdown']."
            },
            "onlyMainContent": {
              "type": "boolean",
              "description": "Strip headers/nav/footers and return only main content (default true)"
            },
            "includeTags": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "HTML tags/selectors to include"
            },
            "excludeTags": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "HTML tags/selectors to exclude"
            },
            "waitFor": {
              "type": "integer",
              "description": "Delay in ms before grabbing content (default 0)"
            },
            "timeout": {
              "type": "integer",
              "description": "Request timeout in ms, 1000-300000 (default 60000)"
            },
            "headers": {
              "type": "object",
              "description": "Headers to send (cookies, user-agent, etc.)"
            },
            "actions": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "Browser actions to run before scraping, e.g. [{ type:'click', selector }, { type:'wait', milliseconds }, { type:'screenshot' }]"
            },
            "mobile": {
              "type": "boolean",
              "description": "Emulate a mobile device"
            },
            "location": {
              "type": "object",
              "description": "{ country, languages[] } geo-targeting for the request"
            }
          }
        },
        "category": "Scraping"
      },
      {
        "id": "parse",
        "label": "Parse Document",
        "description": "Parse a hosted document (PDF, DOCX, etc.) into markdown/other formats. Body: { url (required), formats[] }. Returns { success, data:{ markdown, metadata } }. Synchronous. 1 credit.",
        "verb": "POST",
        "path": "/v2/parse",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "url"
          ],
          "properties": {
            "url": {
              "type": "string",
              "description": "URL of the document to parse"
            },
            "formats": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Output formats (default ['markdown'])"
            }
          }
        },
        "category": "Extraction"
      },
      {
        "id": "startCrawl",
        "label": "Start Crawl (Async Job)",
        "description": "Start crawling a site from a base URL — follows links and scrapes every discovered page. Body: { url (required), limit (max pages, default 10000), maxDiscoveryDepth, includePaths[] (regex), excludePaths[] (regex), allowSubdomains, allowExternalLinks, crawlEntireDomain, sitemap:'skip'|'include'|'only', maxConcurrency, delay, scrapeOptions:{ formats, onlyMainContent, ... }, webhook }. ASYNC — returns { success, id, url } immediately; poll getCrawlStatus. 1 credit (the job then burns 1 credit per page scraped).",
        "verb": "POST",
        "path": "/v2/crawl",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "url"
          ],
          "properties": {
            "url": {
              "type": "string",
              "description": "Base URL to start crawling from"
            },
            "limit": {
              "type": "integer",
              "description": "Max pages to crawl (default 10000)"
            },
            "maxDiscoveryDepth": {
              "type": "integer",
              "description": "Max link-discovery depth from the base URL"
            },
            "includePaths": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "URL pathname regex patterns to include"
            },
            "excludePaths": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "URL pathname regex patterns to exclude"
            },
            "allowSubdomains": {
              "type": "boolean",
              "description": "Follow links into subdomains"
            },
            "allowExternalLinks": {
              "type": "boolean",
              "description": "Follow links to external domains"
            },
            "crawlEntireDomain": {
              "type": "boolean",
              "description": "Follow internal links to sibling/parent URLs, not just children"
            },
            "sitemap": {
              "type": "string",
              "description": "'skip' | 'include' (default) | 'only'"
            },
            "maxConcurrency": {
              "type": "integer",
              "description": "Concurrent scrape limit"
            },
            "delay": {
              "type": "integer",
              "description": "Delay (s) between scrapes to respect rate limits"
            },
            "scrapeOptions": {
              "type": "object",
              "description": "Per-page scrape config, e.g. { formats:['markdown'], onlyMainContent:true }"
            },
            "webhook": {
              "type": "object",
              "description": "Webhook config for crawl event notifications"
            }
          }
        },
        "category": "Scraping",
        "rateLimit": {
          "rpm": 50
        }
      },
      {
        "id": "getCrawlStatus",
        "label": "Get Crawl Status & Data",
        "description": "Poll a crawl job by id. Returns { success, status:'scraping'|'completed'|'failed'|'cancelled', total, completed, creditsUsed, expiresAt, next (URL for next page of data if >10MB), data:[{ markdown, html, links, metadata }] }. Loop until status='completed'; follow `next` to page large result sets. Free.",
        "verb": "GET",
        "path": "/v2/crawl/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Crawl job id returned by startCrawl"
            }
          }
        },
        "category": "Scraping"
      },
      {
        "id": "cancelCrawl",
        "label": "Cancel Crawl",
        "description": "Cancel a running crawl job by id. Returns { status:'cancelled' }. Free.",
        "verb": "DELETE",
        "path": "/v2/crawl/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Crawl job id"
            }
          }
        },
        "category": "Scraping"
      },
      {
        "id": "getCrawlErrors",
        "label": "Get Crawl Errors",
        "description": "List errors encountered during a crawl job. Returns { errors:[{ id, timestamp, url, error }], robotsBlocked:[] }. Use to debug pages that failed or were robots-blocked. Free.",
        "verb": "GET",
        "path": "/v2/crawl/{id}/errors",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Crawl job id"
            }
          }
        },
        "category": "Scraping"
      },
      {
        "id": "crawlParamsPreview",
        "label": "Crawl Params Preview",
        "description": "Preview/expand the effective crawl parameters Firecrawl would use for a URL + natural-language prompt, without starting a crawl. Body: { url, prompt }. Returns the resolved crawl options. Free.",
        "verb": "POST",
        "path": "/v2/crawl/params-preview",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "url"
          ],
          "properties": {
            "url": {
              "type": "string",
              "description": "Base URL"
            },
            "prompt": {
              "type": "string",
              "description": "Natural-language description of what to crawl"
            }
          }
        },
        "category": "Scraping"
      },
      {
        "id": "map",
        "label": "Map Site URLs",
        "description": "Return a fast, complete list of URLs on a site (cheap alternative to crawling when you only need links). Body: { url (required), search (order/filter by relevance, e.g. 'blog'), sitemap:'skip'|'include'|'only', includeSubdomains (default true), ignoreQueryParameters (default true), limit (max 100000, default 5000), timeout, location }. Returns { success, links:[{ url, title, description }] }. Synchronous. 1 credit.",
        "verb": "POST",
        "path": "/v2/map",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "url"
          ],
          "properties": {
            "url": {
              "type": "string",
              "description": "Base URL of the site to map"
            },
            "search": {
              "type": "string",
              "description": "Order/filter results by relevance to this term, e.g. 'pricing'"
            },
            "sitemap": {
              "type": "string",
              "description": "'skip' | 'include' (default) | 'only'"
            },
            "includeSubdomains": {
              "type": "boolean",
              "description": "Include subdomain URLs (default true)"
            },
            "ignoreQueryParameters": {
              "type": "boolean",
              "description": "Drop URLs that differ only by query params (default true)"
            },
            "limit": {
              "type": "integer",
              "description": "Max links returned, up to 100000 (default 5000)"
            },
            "timeout": {
              "type": "integer",
              "description": "Timeout in ms"
            }
          }
        },
        "category": "Scraping"
      },
      {
        "id": "search",
        "label": "Web Search",
        "description": "Search the web and optionally scrape the result pages. Body: { query (required, max 500 chars), limit (per source, default 10, max 100), sources:['web'|'images'|'news'], categories:['github'|'research'|'pdf'], includeDomains[], excludeDomains[], location (e.g. 'Germany'), country (ISO, default 'US'), tbs (e.g. 'qdr:w'), timeout (default 60000), scrapeOptions:{ formats, ... } (set to also scrape each result) }. Returns { success, data:{ web:[{ url, title, description, markdown? }], images:[], news:[] }, creditsUsed }. 1 credit (more when scrapeOptions is set — scrapes each result).",
        "verb": "POST",
        "path": "/v2/search",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "query"
          ],
          "properties": {
            "query": {
              "type": "string",
              "description": "Search query (max 500 chars)"
            },
            "limit": {
              "type": "integer",
              "description": "Results per source (default 10, max 100)"
            },
            "sources": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "['web'|'images'|'news'] (default ['web'])"
            },
            "categories": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Filter by ['github'|'research'|'pdf']"
            },
            "includeDomains": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Restrict to these hostnames"
            },
            "excludeDomains": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Exclude these hostnames"
            },
            "location": {
              "type": "string",
              "description": "Geo-targeting, e.g. 'Germany'"
            },
            "country": {
              "type": "string",
              "description": "ISO country code (default 'US')"
            },
            "tbs": {
              "type": "string",
              "description": "Time-based filter, e.g. 'qdr:w' (past week)"
            },
            "timeout": {
              "type": "integer",
              "description": "Timeout in ms (default 60000)"
            },
            "scrapeOptions": {
              "type": "object",
              "description": "If set, scrape each result, e.g. { formats:['markdown'] }"
            }
          }
        },
        "category": "Search",
        "rateLimit": {
          "rpm": 250
        }
      },
      {
        "id": "startExtract",
        "label": "Start Extract (Async LLM)",
        "description": "Start an LLM structured-extraction job across one or more URLs. Body: { urls[] (glob patterns allowed), prompt, schema (JSON Schema for the output shape), enableWebSearch (default false), ignoreSitemap, includeSubdomains (default true), showSources, scrapeOptions, ignoreInvalidURLs (default true) }. ASYNC — returns { success, id }; poll getExtractStatus. 1 credit (extraction also consumes Extract tokens, tracked separately).",
        "verb": "POST",
        "path": "/v2/extract",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "urls"
          ],
          "properties": {
            "urls": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "URLs to extract from; glob patterns allowed, e.g. 'https://site.com/*'"
            },
            "prompt": {
              "type": "string",
              "description": "Guidance for what to extract"
            },
            "schema": {
              "type": "object",
              "description": "JSON Schema defining the structure of the extracted data"
            },
            "enableWebSearch": {
              "type": "boolean",
              "description": "Allow web search for supporting data (default false)"
            },
            "includeSubdomains": {
              "type": "boolean",
              "description": "Include subdomains when expanding URLs (default true)"
            },
            "showSources": {
              "type": "boolean",
              "description": "Return the source URLs for each field (default false)"
            },
            "scrapeOptions": {
              "type": "object",
              "description": "Scrape config applied to source pages"
            },
            "ignoreInvalidURLs": {
              "type": "boolean",
              "description": "Skip invalid URLs instead of failing (default true)"
            }
          }
        },
        "category": "Extraction",
        "rateLimit": {
          "rpm": 50
        }
      },
      {
        "id": "getExtractStatus",
        "label": "Get Extract Status & Data",
        "description": "Poll an extract job by id. Returns { success, status:'processing'|'completed'|'failed'|'cancelled', data (the structured object/array matching your schema), sources? }. Loop until status='completed'. Free.",
        "verb": "GET",
        "path": "/v2/extract/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Extract job id returned by startExtract"
            }
          }
        },
        "category": "Extraction"
      },
      {
        "id": "extract",
        "label": "Extract (LLM, waits for completion)",
        "description": "Run an LLM structured-extraction across one or more URLs and BLOCK until it finishes, returning the structured data (the object/array matching your schema). Same inputs as startExtract — but no polling needed: this starts the job and waits server-side, throwing on failure or timeout. Prefer this over startExtract+getExtractStatus when you just want the result in one call (e.g. from a column). 1 credit.",
        "verb": "POST",
        "path": "/v2/extract",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "urls"
          ],
          "properties": {
            "urls": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "URLs to extract from; glob patterns allowed, e.g. 'https://site.com/*'"
            },
            "prompt": {
              "type": "string",
              "description": "Guidance for what to extract"
            },
            "schema": {
              "type": "object",
              "description": "JSON Schema defining the structure of the extracted data"
            },
            "enableWebSearch": {
              "type": "boolean",
              "description": "Allow web search for supporting data (default false)"
            },
            "includeSubdomains": {
              "type": "boolean",
              "description": "Include subdomains when expanding URLs (default true)"
            },
            "showSources": {
              "type": "boolean",
              "description": "Return the source URLs for each field (default false)"
            },
            "scrapeOptions": {
              "type": "object",
              "description": "Scrape config applied to source pages"
            },
            "ignoreInvalidURLs": {
              "type": "boolean",
              "description": "Skip invalid URLs instead of failing (default true)"
            }
          }
        },
        "poll": {
          "statusMethod": "getExtractStatus",
          "idFrom": "id",
          "idParam": "id",
          "statusFrom": "status",
          "doneWhen": "completed",
          "failWhen": [
            "failed",
            "cancelled"
          ],
          "dataFrom": "data",
          "intervalMs": 3000,
          "timeoutMs": 300000
        },
        "rateLimit": {
          "rpm": 50
        }
      },
      {
        "id": "startBatchScrape",
        "label": "Start Batch Scrape (Async Job)",
        "description": "Scrape many known URLs in one job (same scrape options applied to all). Body: { urls[] (required), formats[], onlyMainContent (default true), maxConcurrency, ignoreInvalidURLs (default true), zeroDataRetention, scrapeOptions{ headers, waitFor, timeout, actions, location, ... }, webhook }. ASYNC — returns { success, id, invalidURLs[] }; poll getBatchScrapeStatus. 1 credit (the job burns 1 credit per URL scraped).",
        "verb": "POST",
        "path": "/v2/batch/scrape",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "urls"
          ],
          "properties": {
            "urls": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "List of URLs to scrape"
            },
            "formats": {
              "type": "array",
              "items": {},
              "description": "Output formats applied to every URL, e.g. ['markdown','html']"
            },
            "onlyMainContent": {
              "type": "boolean",
              "description": "Strip headers/nav/footers (default true)"
            },
            "maxConcurrency": {
              "type": "integer",
              "description": "Concurrent scrape limit"
            },
            "ignoreInvalidURLs": {
              "type": "boolean",
              "description": "Skip invalid URLs instead of failing the request (default true)"
            },
            "scrapeOptions": {
              "type": "object",
              "description": "Advanced per-URL scrape config (waitFor, actions, location, etc.)"
            },
            "webhook": {
              "type": "object",
              "description": "Webhook config for batch event notifications"
            }
          }
        },
        "category": "Scraping",
        "rateLimit": {
          "rpm": 50
        }
      },
      {
        "id": "getBatchScrapeStatus",
        "label": "Get Batch Scrape Status & Data",
        "description": "Poll a batch-scrape job by id. Returns { success, status:'scraping'|'completed'|'failed', total, completed, creditsUsed, expiresAt, next (next page URL if >10MB), data:[{ markdown, html, metadata }] }. Loop until status='completed'; follow `next` to page. Free.",
        "verb": "GET",
        "path": "/v2/batch/scrape/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Batch scrape job id returned by startBatchScrape"
            }
          }
        },
        "category": "Scraping"
      },
      {
        "id": "cancelBatchScrape",
        "label": "Cancel Batch Scrape",
        "description": "Cancel a running batch-scrape job by id. Returns { status:'cancelled' }. Free.",
        "verb": "DELETE",
        "path": "/v2/batch/scrape/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Batch scrape job id"
            }
          }
        },
        "category": "Scraping"
      },
      {
        "id": "getBatchScrapeErrors",
        "label": "Get Batch Scrape Errors",
        "description": "List errors from a batch-scrape job. Returns { errors:[{ id, timestamp, url, error }], robotsBlocked:[] }. Free.",
        "verb": "GET",
        "path": "/v2/batch/scrape/{id}/errors",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Batch scrape job id"
            }
          }
        },
        "category": "Scraping"
      },
      {
        "id": "getCreditUsage",
        "label": "Get Credit Usage",
        "description": "Get the team's remaining credits and plan info. Returns { success, data:{ remainingCredits, planCredits, billingPeriodStart, billingPeriodEnd } }. Call before large crawl/batch/extract jobs. Free.",
        "verb": "GET",
        "path": "/v2/team/credit-usage",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "getCreditUsageHistorical",
        "label": "Get Historical Credit Usage",
        "description": "Get month-by-month historical credit usage for the team. Query: byApiKey?. Returns usage broken down by billing period. Free.",
        "verb": "GET",
        "path": "/v2/team/credit-usage/historical",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "byApiKey": {
              "type": "boolean",
              "description": "Break usage down per API key"
            }
          }
        }
      },
      {
        "id": "getTokenUsage",
        "label": "Get Token Usage (Extract)",
        "description": "Get the team's remaining Extract tokens and plan info (Extract is billed in tokens, separately from credits). Returns { success, data:{ remainingTokens, planTokens, billingPeriodStart, billingPeriodEnd } }. Call before large extract jobs. Free.",
        "verb": "GET",
        "path": "/v2/team/token-usage",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      }
    ]
  },
  {
    "id": "fireflies",
    "name": "Fireflies",
    "version": "1.0.0",
    "category": "meetings",
    "description": "Meeting transcripts, summaries & action items. GraphQL API — pass a query + variables.",
    "baseUrl": "https://api.fireflies.ai",
    "logo": "https://www.google.com/s2/favicons?domain=fireflies.ai&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "Authorization",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 60,
      "concurrency": 2
    },
    "methods": [
      {
        "id": "graphql",
        "label": "GraphQL Query",
        "description": "Run a Fireflies GraphQL query. Pass `query` (a GraphQL string) and optional `variables`. Errors come back in a top-level `errors` array even on HTTP 200. Useful queries:\n• List recent meetings: query Transcripts($limit:Int){ transcripts(limit:$limit){ id title date transcript_url duration } }\n• Full transcript + summary: query Transcript($transcriptId:String!){ transcript(id:$transcriptId){ title sentences{ text speaker_name } summary{ overview action_items keywords } } }\n• Account: query{ users{ user_id name email num_transcripts minutes_consumed } }",
        "verb": "POST",
        "path": "/graphql",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "query"
          ],
          "properties": {
            "query": {
              "type": "string",
              "description": "GraphQL query string"
            },
            "variables": {
              "type": "object",
              "description": "Variables object referenced by the query, e.g. { \"transcriptId\": \"...\" }"
            }
          }
        }
      }
    ]
  },
  {
    "id": "fullenrich",
    "name": "FullEnrich",
    "version": "1.0.0",
    "category": "enrichment",
    "description": "Waterfall email & phone enrichment across 15+ vendors. Async: submit a bulk, then poll for the result.",
    "baseUrl": "https://app.fullenrich.com/api/v1",
    "logo": "https://www.google.com/s2/favicons?domain=fullenrich.com&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "Authorization",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 60,
      "concurrency": 5
    },
    "methods": [
      {
        "id": "enrichBulk",
        "label": "Enrich Bulk (submit)",
        "description": "Submit up to 100 contacts for waterfall email/phone enrichment. `datas` is an array, each with firstname, lastname, domain, company_name, linkedin_url, and enrich_fields (e.g. [\"contact.emails\",\"contact.phones\"]). Returns { enrichment_id } — poll Get Result with it. ASYNC: results are not ready immediately.",
        "verb": "POST",
        "path": "/contact/enrich/bulk",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "datas"
          ],
          "properties": {
            "name": {
              "type": "string",
              "description": "Label for this bulk, e.g. 'Sales Ops London'"
            },
            "webhook_url": {
              "type": "string",
              "description": "Optional webhook POSTed when finished"
            },
            "datas": {
              "type": "array",
              "description": "Array of contacts (1-100). Each: { firstname, lastname, domain, company_name, linkedin_url, enrich_fields: [\"contact.emails\",\"contact.phones\"] }",
              "items": {
                "type": "object"
              }
            }
          }
        },
        "category": "Find email",
        "rateLimit": {
          "rps": 1,
          "concurrency": 100
        }
      },
      {
        "id": "getResult",
        "label": "Get Result (poll)",
        "description": "Fetch enrichment results by enrichment_id (from Enrich Bulk). Returns { status, datas[] } where status is CREATED|IN_PROGRESS until done then FINISHED. Each item: datas[].contact { most_probable_email, emails[]{email,status}, phones[]{number,region} }.",
        "verb": "GET",
        "path": "/contact/enrich/bulk/{enrichment_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "enrichment_id"
          ],
          "properties": {
            "enrichment_id": {
              "type": "string",
              "description": "The id returned by Enrich Bulk"
            }
          }
        },
        "category": "Find email"
      },
      {
        "id": "credits",
        "label": "Get Credits",
        "description": "Get remaining workspace credits. Returns { balance }.",
        "verb": "GET",
        "path": "/account/credits",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      }
    ]
  },
  {
    "id": "granola",
    "name": "Granola",
    "version": "1.0.0",
    "category": "meetings",
    "description": "AI meeting notes — pull your summarized notes and full transcripts. Requires a Business-plan API key (grn_...).",
    "baseUrl": "https://public-api.granola.ai/v1",
    "logo": "https://www.google.com/s2/favicons?domain=granola.ai&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "Authorization",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 300,
      "rps": 5,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "listNotes",
        "label": "List Notes",
        "description": "List meeting notes that have a generated AI summary. Supports date and folder filters plus cursor pagination. Returns { notes:[{id,object,title,owner,created_at,updated_at}], hasMore, cursor }. Notes without a summary are excluded.",
        "verb": "GET",
        "path": "/notes",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "created_after": {
              "type": "string",
              "description": "ISO 8601 — only notes created on/after this time"
            },
            "created_before": {
              "type": "string",
              "description": "ISO 8601 — only notes created before this time"
            },
            "updated_after": {
              "type": "string",
              "description": "ISO 8601 — only notes updated on/after this time"
            },
            "folder_id": {
              "type": "string",
              "description": "Scope to a folder (and its children). Folder id (fol_...)"
            },
            "page_size": {
              "type": "integer",
              "description": "Page size, 1-30 (default 10)"
            },
            "cursor": {
              "type": "string",
              "description": "Pagination cursor (from previous response)"
            }
          }
        },
        "options": {
          "folder_id": {
            "method": "listFolders",
            "itemsPath": "folders",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "page_size": 30
            }
          }
        }
      },
      {
        "id": "getNote",
        "label": "Get Note",
        "description": "Get a single note by id (note_id, not_...). Pass include='transcript' to also return the full transcript. Returns the note detail (summary_text, summary_markdown, attendees, calendar_event, optionally transcript).",
        "verb": "GET",
        "path": "/notes/{note_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "note_id"
          ],
          "properties": {
            "note_id": {
              "type": "string",
              "description": "Note id (not_...)"
            },
            "include": {
              "type": "string",
              "description": "Set to 'transcript' to include the full transcript"
            }
          }
        }
      },
      {
        "id": "listFolders",
        "label": "List Folders",
        "description": "List accessible folders alphabetically, cursor-paginated. Returns { folders:[{id,object,name,parent_folder_id}], hasMore, cursor }. Folder ids look like fol_...; feed one into listNotes folder_id.",
        "verb": "GET",
        "path": "/folders",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "page_size": {
              "type": "integer",
              "description": "Page size, 1-30 (default 10)"
            },
            "cursor": {
              "type": "string",
              "description": "Pagination cursor"
            }
          }
        }
      }
    ]
  },
  {
    "id": "heyreach",
    "name": "HeyReach",
    "version": "1.1.0",
    "category": "outreach",
    "description": "LinkedIn outreach automation — manage campaigns, push leads, and read your inbox.",
    "baseUrl": "https://api.heyreach.io/api/public",
    "logo": "https://www.google.com/s2/favicons?domain=heyreach.io&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "X-API-KEY",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 300,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "checkApiKey",
        "label": "Check API Key",
        "description": "Validate the connected HeyReach API key. Returns 200 if valid.",
        "verb": "GET",
        "path": "/auth/CheckApiKey",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "listCampaigns",
        "label": "List Campaigns",
        "description": "List campaigns with progress stats. Optional keyword/status filters. Returns { items[], totalCount }.",
        "verb": "POST",
        "path": "/campaign/GetAll",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "offset": {
              "type": "integer",
              "description": "Pagination offset (default 0)"
            },
            "limit": {
              "type": "integer",
              "description": "Max results, up to 100 (default 10)"
            },
            "keyword": {
              "type": "string",
              "description": "Filter by campaign name"
            }
          }
        }
      },
      {
        "id": "getCampaign",
        "label": "Get Campaign",
        "description": "Get a single campaign (incl. sequence + stats) by its id.",
        "verb": "GET",
        "path": "/campaign/GetById",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "campaignId"
          ],
          "properties": {
            "campaignId": {
              "type": "integer",
              "description": "HeyReach campaign id"
            }
          }
        },
        "options": {
          "campaignId": {
            "method": "listCampaigns",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "pauseCampaign",
        "label": "Pause Campaign",
        "description": "Pause a running campaign by id (stops sending). No body beyond the id.",
        "verb": "POST",
        "path": "/campaign/Pause",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "campaignId"
          ],
          "properties": {
            "campaignId": {
              "type": "integer",
              "description": "HeyReach campaign id"
            }
          }
        },
        "options": {
          "campaignId": {
            "method": "listCampaigns",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "resumeCampaign",
        "label": "Resume Campaign",
        "description": "Resume a paused campaign by id (begins sending again).",
        "verb": "POST",
        "path": "/campaign/Resume",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "campaignId"
          ],
          "properties": {
            "campaignId": {
              "type": "integer",
              "description": "HeyReach campaign id"
            }
          }
        },
        "options": {
          "campaignId": {
            "method": "listCampaigns",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "addLeadsToCampaign",
        "label": "Add Leads to Campaign",
        "description": "Push LinkedIn leads into a campaign (max 100). Each lead needs profileUrl + firstName + lastName. linkedInAccountId is optional (binds the lead to a specific sender already on the campaign). Map grid columns into firstName/lastName/companyName/position/emailAddress and any custom fields.",
        "verb": "POST",
        "path": "/campaign/AddLeadsToCampaignV2",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "campaignId",
            "accountLeadPairs"
          ],
          "properties": {
            "campaignId": {
              "type": "integer",
              "description": "Target campaign id"
            },
            "accountLeadPairs": {
              "type": "array",
              "description": "Up to 100 pairs of { linkedInAccountId?, lead }",
              "items": {
                "type": "object",
                "properties": {
                  "linkedInAccountId": {
                    "type": "integer",
                    "description": "Sender account id (optional)"
                  },
                  "lead": {
                    "type": "object",
                    "required": [
                      "profileUrl",
                      "firstName",
                      "lastName"
                    ],
                    "properties": {
                      "profileUrl": {
                        "type": "string"
                      },
                      "firstName": {
                        "type": "string"
                      },
                      "lastName": {
                        "type": "string"
                      },
                      "companyName": {
                        "type": "string"
                      },
                      "position": {
                        "type": "string"
                      },
                      "emailAddress": {
                        "type": "string"
                      },
                      "location": {
                        "type": "string"
                      },
                      "summary": {
                        "type": "string",
                        "description": "Headline/summary text"
                      },
                      "customUserFields": {
                        "type": "array",
                        "description": "Custom personalization variables sent alongside the standard fields — each { name, value }. Map a grid column into each value to reference it as a merge tag in your sequence. The API accepts as many as you add.",
                        "items": {
                          "type": "object",
                          "required": [
                            "name",
                            "value"
                          ],
                          "properties": {
                            "name": {
                              "type": "string",
                              "description": "Variable name (the merge tag used in your sequence)"
                            },
                            "value": {
                              "type": "string",
                              "description": "Variable value (map a column)"
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "options": {
          "campaignId": {
            "method": "listCampaigns",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "listLists",
        "label": "List Lead Lists",
        "description": "List your lead/company lists. Returns { items[], totalCount }.",
        "verb": "POST",
        "path": "/list/GetAll",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "offset": {
              "type": "integer"
            },
            "limit": {
              "type": "integer",
              "description": "Up to 100"
            },
            "keyword": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "addLeadsToList",
        "label": "Add Leads to List",
        "description": "Add LinkedIn leads to a list (max 100). Each lead needs profileUrl + firstName + lastName.",
        "verb": "POST",
        "path": "/list/AddLeadsToListV2",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "listId",
            "leads"
          ],
          "properties": {
            "listId": {
              "type": "integer"
            },
            "leads": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "profileUrl",
                  "firstName",
                  "lastName"
                ],
                "properties": {
                  "profileUrl": {
                    "type": "string"
                  },
                  "firstName": {
                    "type": "string"
                  },
                  "lastName": {
                    "type": "string"
                  },
                  "companyName": {
                    "type": "string"
                  },
                  "position": {
                    "type": "string"
                  },
                  "emailAddress": {
                    "type": "string"
                  },
                  "location": {
                    "type": "string"
                  },
                  "customUserFields": {
                    "type": "array",
                    "description": "Custom personalization variables sent alongside the standard fields — each { name, value }. Map a grid column into each value. The API accepts as many as you add.",
                    "items": {
                      "type": "object",
                      "required": [
                        "name",
                        "value"
                      ],
                      "properties": {
                        "name": {
                          "type": "string",
                          "description": "Variable name (the merge tag used in your sequence)"
                        },
                        "value": {
                          "type": "string",
                          "description": "Variable value (map a column)"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "options": {
          "listId": {
            "method": "listLists",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "listSenders",
        "label": "List LinkedIn Senders",
        "description": "List connected LinkedIn sender accounts (their ids are the linkedInAccountId used elsewhere).",
        "verb": "POST",
        "path": "/li_account/GetAll",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "offset": {
              "type": "integer"
            },
            "limit": {
              "type": "integer"
            },
            "keyword": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "getConversations",
        "label": "Get Conversations",
        "description": "Read inbox conversations. Filter by sender account, campaign, or a specific lead's profile URL.",
        "verb": "POST",
        "path": "/inbox/GetConversationsV2",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "offset": {
              "type": "integer"
            },
            "limit": {
              "type": "integer",
              "description": "Up to 100"
            },
            "filters": {
              "type": "object",
              "properties": {
                "campaignIds": {
                  "type": "array",
                  "items": {
                    "type": "integer"
                  }
                },
                "linkedInAccountIds": {
                  "type": "array",
                  "items": {
                    "type": "integer"
                  }
                },
                "leadProfileUrl": {
                  "type": "string"
                },
                "searchString": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      {
        "id": "getCampaignLeads",
        "label": "Get Leads from Campaign",
        "description": "List leads enrolled in a campaign with their per-lead status/progress. Returns { items[], totalCount }. Pick the campaign by name.",
        "verb": "POST",
        "path": "/campaign/GetLeadsFromCampaign",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "campaignId"
          ],
          "properties": {
            "campaignId": {
              "type": "integer",
              "description": "HeyReach campaign id"
            },
            "offset": {
              "type": "integer",
              "description": "Pagination offset (default 0)"
            },
            "limit": {
              "type": "integer",
              "description": "Max results, up to 100 (default 10)"
            }
          }
        },
        "options": {
          "campaignId": {
            "method": "listCampaigns",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "stopLeadInCampaign",
        "label": "Stop Lead in Campaign",
        "description": "Stop/remove a single lead (by LinkedIn profile URL) from a running campaign so it receives no further steps.",
        "verb": "POST",
        "path": "/campaign/StopLeadInCampaign",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "campaignId",
            "leadprofileUrl"
          ],
          "properties": {
            "campaignId": {
              "type": "integer",
              "description": "HeyReach campaign id"
            },
            "leadprofileUrl": {
              "type": "string",
              "description": "Lead's LinkedIn profile URL"
            }
          }
        },
        "options": {
          "campaignId": {
            "method": "listCampaigns",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "createList",
        "label": "Create Lead List",
        "description": "Create a new empty lead/company list. Requires a name; returns the created list incl. its numeric id (use it with addLeadsToList).",
        "verb": "POST",
        "path": "/list/CreateEmptyList",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string",
              "description": "List name"
            },
            "listType": {
              "type": "string",
              "description": "Optional list type, e.g. 'USER_LIST' (leads) or 'COMPANY_LIST'"
            }
          }
        }
      },
      {
        "id": "getList",
        "label": "Get Lead List",
        "description": "Get a single lead/company list (incl. lead count) by its id. Pick the list by name.",
        "verb": "GET",
        "path": "/list/GetById",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "listId"
          ],
          "properties": {
            "listId": {
              "type": "integer",
              "description": "HeyReach list id"
            }
          }
        },
        "options": {
          "listId": {
            "method": "listLists",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "getListLeads",
        "label": "Get Leads from List",
        "description": "List the leads inside a lead list. Returns { items[], totalCount }. Pick the list by name.",
        "verb": "POST",
        "path": "/list/GetLeadsFromList",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "listId"
          ],
          "properties": {
            "listId": {
              "type": "integer",
              "description": "HeyReach list id"
            },
            "offset": {
              "type": "integer",
              "description": "Pagination offset (default 0)"
            },
            "limit": {
              "type": "integer",
              "description": "Max results, up to 100 (default 10)"
            }
          }
        },
        "options": {
          "listId": {
            "method": "listLists",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "getSender",
        "label": "Get LinkedIn Sender",
        "description": "Get a single connected LinkedIn sender account by its id. Pick the sender by name/email.",
        "verb": "GET",
        "path": "/li_account/GetById",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "accountId"
          ],
          "properties": {
            "accountId": {
              "type": "integer",
              "description": "LinkedIn sender account id (linkedInAccountId)"
            }
          }
        },
        "options": {
          "accountId": {
            "method": "listSenders",
            "itemsPath": "items",
            "labelKey": "emailAddress",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "sendMessage",
        "label": "Send Inbox Message",
        "description": "Send a LinkedIn message in an existing conversation. Provide the conversationId (from getConversations), the sender linkedInAccountId, and the message body.",
        "verb": "POST",
        "path": "/inbox/SendMessage",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "conversationId",
            "message"
          ],
          "properties": {
            "conversationId": {
              "type": "string",
              "description": "Conversation id from getConversations"
            },
            "linkedInAccountId": {
              "type": "integer",
              "description": "Sender account id to send from"
            },
            "message": {
              "type": "string",
              "description": "Message text"
            },
            "subject": {
              "type": "string",
              "description": "Optional subject (InMail)"
            }
          }
        },
        "options": {
          "linkedInAccountId": {
            "method": "listSenders",
            "itemsPath": "items",
            "labelKey": "emailAddress",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "getOverallStats",
        "label": "Get Overall Stats",
        "description": "Aggregate outreach stats (profile views, connections sent/accepted, messages sent/replied, InMails, reply/acceptance rates) over a date range. Optionally scope to specific campaigns and/or sender accounts (arrays of ids). Day-by-day + totals.",
        "verb": "POST",
        "path": "/stats/GetOverallStats",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "startDate": {
              "type": "string",
              "description": "ISO date (inclusive)"
            },
            "endDate": {
              "type": "string",
              "description": "ISO date (inclusive)"
            },
            "accountIds": {
              "type": "array",
              "description": "Sender account ids to scope to (omit for all)",
              "items": {
                "type": "integer"
              }
            },
            "campaignIds": {
              "type": "array",
              "description": "Campaign ids to scope to (omit for all)",
              "items": {
                "type": "integer"
              }
            }
          }
        }
      },
      {
        "id": "getMyNetwork",
        "label": "Get Sender Network",
        "description": "List the 1st-degree LinkedIn connections of one sender account. Returns { items[], totalCount }. Pick the sender by name/email.",
        "verb": "POST",
        "path": "/MyNetwork/GetMyNetworkForSender",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "senderId"
          ],
          "properties": {
            "senderId": {
              "type": "integer",
              "description": "LinkedIn sender account id"
            },
            "offset": {
              "type": "integer",
              "description": "Pagination offset (default 0)"
            },
            "limit": {
              "type": "integer",
              "description": "Max results, up to 100 (default 10)"
            }
          }
        },
        "options": {
          "senderId": {
            "method": "listSenders",
            "itemsPath": "items",
            "labelKey": "emailAddress",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "listWebhooks",
        "label": "List Webhooks",
        "description": "List configured webhooks (event subscriptions). Returns { items[], totalCount }.",
        "verb": "GET",
        "path": "/webhook/GetAllWebhooks",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "createWebhook",
        "label": "Create Webhook",
        "description": "Create a webhook subscription for an event type (e.g. CONNECTION_ACCEPTED, MESSAGE_REPLY). Optionally scope to specific campaigns. Posts events to your webhookUrl.",
        "verb": "POST",
        "path": "/webhook/CreateWebhook",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "webhookName",
            "webhookUrl",
            "eventType"
          ],
          "properties": {
            "webhookName": {
              "type": "string",
              "description": "Display name for the webhook"
            },
            "webhookUrl": {
              "type": "string",
              "description": "HTTPS URL to receive event POSTs"
            },
            "eventType": {
              "type": "string",
              "description": "Event to subscribe to, e.g. CONNECTION_ACCEPTED | MESSAGE_REPLY"
            },
            "campaignIds": {
              "type": "array",
              "description": "Optional campaign ids to scope events to",
              "items": {
                "type": "integer"
              }
            }
          }
        }
      },
      {
        "id": "deleteWebhook",
        "label": "Delete Webhook",
        "description": "Delete a webhook subscription by its id. Pick the webhook by name.",
        "verb": "POST",
        "path": "/webhook/DeleteWebhook",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "webhookId"
          ],
          "properties": {
            "webhookId": {
              "type": "integer",
              "description": "Webhook id"
            }
          }
        },
        "options": {
          "webhookId": {
            "method": "listWebhooks",
            "itemsPath": "items",
            "labelKey": "webhookName",
            "valueKey": "id",
            "args": {}
          }
        }
      }
    ]
  },
  {
    "id": "hubspot",
    "name": "HubSpot",
    "version": "1.0.0",
    "category": "crm",
    "description": "HubSpot CRM — read, search, create, update and associate contacts, companies, deals, tickets and other CRM records, plus properties, owners, pipelines, engagements and lists.",
    "logo": "https://www.google.com/s2/favicons?domain=hubspot.com&sz=128",
    "baseUrl": "https://api.hubapi.com",
    "auth": {
      "type": "apiKey",
      "header": "Authorization",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 600,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "listContacts",
        "label": "List Contacts",
        "description": "List contacts (paginated). Returns { results[]{ id, properties{}, createdAt, updatedAt }, paging{ next{ after } } }. Use `properties` to choose which fields come back (default returns a minimal set). Page with `after` from paging.next. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/contacts",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Page size, max 100 (default 10)"
            },
            "after": {
              "type": "string",
              "description": "Pagination cursor from paging.next.after"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Property names to return, e.g. ['email','firstname','lastname','company']"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Associated object types to include, e.g. ['companies','deals']"
            },
            "archived": {
              "type": "boolean",
              "description": "Return only archived records (default false)"
            }
          }
        }
      },
      {
        "id": "getContact",
        "label": "Get Contact",
        "description": "Get one contact by record id. Returns { id, properties{}, createdAt, updatedAt, associations{} }. Pass `properties` to control returned fields. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/contacts/{contactId}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "contactId"
          ],
          "properties": {
            "contactId": {
              "type": "string",
              "description": "Contact record id (or an idProperty value if idProperty is set)"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Property names to return"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Associated object types to include"
            },
            "idProperty": {
              "type": "string",
              "description": "Look up by a unique property instead of id, e.g. 'email'"
            },
            "archived": {
              "type": "boolean"
            }
          }
        }
      },
      {
        "id": "searchContacts",
        "label": "Search Contacts",
        "description": "Search contacts with filters. Body: filterGroups[] (AND of groups, OR between groups) each with filters[]{ propertyName, operator, value/values }, plus sorts[], properties[] (fields to return), query (free-text), limit (max 100), after (cursor). Operators: EQ, NEQ, GT, GTE, LT, LTE, CONTAINS_TOKEN, HAS_PROPERTY, IN, etc. Returns { total, results[], paging }. Free read.",
        "verb": "POST",
        "path": "/crm/v3/objects/contacts/search",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "filterGroups": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "Array of { filters: [{ propertyName, operator, value }] }; groups are OR'd, filters within a group are AND'd (max 5 groups, 6 filters each)"
            },
            "sorts": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "[{ propertyName, direction: 'ASCENDING'|'DESCENDING' }]"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Property names to return for matches"
            },
            "query": {
              "type": "string",
              "description": "Free-text search across default searchable properties"
            },
            "limit": {
              "type": "integer",
              "description": "Max 100 (default 10)"
            },
            "after": {
              "type": "string",
              "description": "Pagination cursor"
            }
          }
        },
        "rateLimit": {
          "rps": 4
        }
      },
      {
        "id": "createContact",
        "label": "Create Contact",
        "description": "Create a contact. Body: { properties: { email, firstname, lastname, ... }, associations? }. `email` is the standard unique key. Returns the created { id, properties }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/contacts",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "Map of property name → value, e.g. { email, firstname, lastname, phone, company }"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "Optional [{ to:{ id }, types:[{ associationCategory, associationTypeId }] }]"
            }
          }
        }
      },
      {
        "id": "updateContact",
        "label": "Update Contact",
        "description": "Update a contact by id. Body: { properties: { ... } } — only included properties change. Returns updated { id, properties }. Write — 1 credit.",
        "verb": "PATCH",
        "path": "/crm/v3/objects/contacts/{contactId}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "contactId",
            "properties"
          ],
          "properties": {
            "contactId": {
              "type": "string"
            },
            "properties": {
              "type": "object",
              "description": "Property name → new value"
            },
            "idProperty": {
              "type": "string",
              "description": "Update by a unique property instead of id, e.g. 'email'"
            }
          }
        }
      },
      {
        "id": "archiveContact",
        "label": "Archive Contact",
        "description": "Archive (soft-delete) a contact by id. Returns 204 No Content. Write — 1 credit.",
        "verb": "DELETE",
        "path": "/crm/v3/objects/contacts/{contactId}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "contactId"
          ],
          "properties": {
            "contactId": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "batchReadContacts",
        "label": "Batch Read Contacts",
        "description": "Read up to 100 contacts at once by id (or by a unique idProperty). Body: { inputs:[{ id }], properties:[], idProperty? }. Returns { results[] }. Free read but counts as a batch op — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/contacts/batch/read",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "Up to 100 of { id }"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "propertiesWithHistory": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "idProperty": {
              "type": "string",
              "description": "e.g. 'email' to read by email instead of id"
            }
          }
        }
      },
      {
        "id": "batchCreateContacts",
        "label": "Batch Create Contacts",
        "description": "Create up to 100 contacts in one call. Body: { inputs:[{ properties:{}, associations? }] }. Returns { results[] }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/contacts/batch/create",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "Up to 100 of { properties:{...} }"
            }
          }
        }
      },
      {
        "id": "batchUpdateContacts",
        "label": "Batch Update Contacts",
        "description": "Update up to 100 contacts in one call. Body: { inputs:[{ id, properties:{} }] }. Returns { results[] }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/contacts/batch/update",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "Up to 100 of { id, properties:{...} }"
            }
          }
        }
      },
      {
        "id": "listCompanies",
        "label": "List Companies",
        "description": "List companies (paginated). Returns { results[]{ id, properties{}, createdAt, updatedAt }, paging }. Use `properties` to pick fields (e.g. name, domain, industry). Page with `after`. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/companies",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100 (default 10)"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "e.g. ['name','domain','industry','numberofemployees']"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "archived": {
              "type": "boolean"
            }
          }
        }
      },
      {
        "id": "getCompany",
        "label": "Get Company",
        "description": "Get one company by record id. Returns { id, properties{}, associations{} }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/companies/{companyId}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "companyId"
          ],
          "properties": {
            "companyId": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "idProperty": {
              "type": "string",
              "description": "e.g. 'domain'"
            },
            "archived": {
              "type": "boolean"
            }
          }
        }
      },
      {
        "id": "searchCompanies",
        "label": "Search Companies",
        "description": "Search companies with filterGroups/sorts/properties/query/limit/after (same shape as searchContacts). Common: filter by domain CONTAINS_TOKEN or name. Returns { total, results[], paging }. Free read.",
        "verb": "POST",
        "path": "/crm/v3/objects/companies/search",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "filterGroups": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "sorts": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "query": {
              "type": "string"
            },
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            }
          }
        },
        "rateLimit": {
          "rps": 4
        }
      },
      {
        "id": "createCompany",
        "label": "Create Company",
        "description": "Create a company. Body: { properties:{ name, domain, ... }, associations? }. `domain` is the standard unique key. Returns created { id, properties }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/companies",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "e.g. { name, domain, industry, city }"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "updateCompany",
        "label": "Update Company",
        "description": "Update a company by id. Body: { properties:{} }. Returns updated record. Write — 1 credit.",
        "verb": "PATCH",
        "path": "/crm/v3/objects/companies/{companyId}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "companyId",
            "properties"
          ],
          "properties": {
            "companyId": {
              "type": "string"
            },
            "properties": {
              "type": "object"
            },
            "idProperty": {
              "type": "string",
              "description": "e.g. 'domain'"
            }
          }
        }
      },
      {
        "id": "archiveCompany",
        "label": "Archive Company",
        "description": "Archive (soft-delete) a company by id. Returns 204. Write — 1 credit.",
        "verb": "DELETE",
        "path": "/crm/v3/objects/companies/{companyId}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "companyId"
          ],
          "properties": {
            "companyId": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "batchReadCompanies",
        "label": "Batch Read Companies",
        "description": "Read up to 100 companies by id (or idProperty like 'domain'). Body: { inputs:[{ id }], properties:[], idProperty? }. Returns { results[] }. 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/companies/batch/read",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "idProperty": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "batchCreateCompanies",
        "label": "Batch Create Companies",
        "description": "Create up to 100 companies. Body: { inputs:[{ properties:{} }] }. Returns { results[] }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/companies/batch/create",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "batchUpdateCompanies",
        "label": "Batch Update Companies",
        "description": "Update up to 100 companies. Body: { inputs:[{ id, properties:{} }] }. Returns { results[] }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/companies/batch/update",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "listDeals",
        "label": "List Deals",
        "description": "List deals (paginated). Returns { results[]{ id, properties{}, ... }, paging }. Useful properties: dealname, amount, dealstage, pipeline, closedate. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/deals",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "e.g. ['dealname','amount','dealstage','pipeline','closedate']"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "archived": {
              "type": "boolean"
            }
          }
        }
      },
      {
        "id": "getDeal",
        "label": "Get Deal",
        "description": "Get one deal by record id. Returns { id, properties{}, associations{} }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/deals/{dealId}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "dealId"
          ],
          "properties": {
            "dealId": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "archived": {
              "type": "boolean"
            }
          }
        }
      },
      {
        "id": "searchDeals",
        "label": "Search Deals",
        "description": "Search deals with filterGroups/sorts/properties/query/limit/after. Common: filter by dealstage, pipeline, amount GT, or hs_lastmodifieddate. Returns { total, results[], paging }. Free read.",
        "verb": "POST",
        "path": "/crm/v3/objects/deals/search",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "filterGroups": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "sorts": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "query": {
              "type": "string"
            },
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            }
          }
        },
        "rateLimit": {
          "rps": 4
        }
      },
      {
        "id": "createDeal",
        "label": "Create Deal",
        "description": "Create a deal. Body: { properties:{ dealname, amount, dealstage, pipeline, ... }, associations? }. dealstage must be a valid stage id for the chosen pipeline (see listDealPipelines). Returns created { id, properties }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/deals",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "e.g. { dealname, amount, dealstage, pipeline, closedate }"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "Associate to contacts/companies on create"
            }
          }
        }
      },
      {
        "id": "updateDeal",
        "label": "Update Deal",
        "description": "Update a deal by id (e.g. move stage, set amount). Body: { properties:{} }. Returns updated record. Write — 1 credit.",
        "verb": "PATCH",
        "path": "/crm/v3/objects/deals/{dealId}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "dealId",
            "properties"
          ],
          "properties": {
            "dealId": {
              "type": "string"
            },
            "properties": {
              "type": "object"
            }
          }
        }
      },
      {
        "id": "archiveDeal",
        "label": "Archive Deal",
        "description": "Archive (soft-delete) a deal by id. Returns 204. Write — 1 credit.",
        "verb": "DELETE",
        "path": "/crm/v3/objects/deals/{dealId}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "dealId"
          ],
          "properties": {
            "dealId": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "batchReadDeals",
        "label": "Batch Read Deals",
        "description": "Read up to 100 deals by id. Body: { inputs:[{ id }], properties:[] }. Returns { results[] }. 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/deals/batch/read",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "batchCreateDeals",
        "label": "Batch Create Deals",
        "description": "Create up to 100 deals. Body: { inputs:[{ properties:{} }] }. Returns { results[] }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/deals/batch/create",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "batchUpdateDeals",
        "label": "Batch Update Deals",
        "description": "Update up to 100 deals. Body: { inputs:[{ id, properties:{} }] }. Returns { results[] }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/deals/batch/update",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "listTickets",
        "label": "List Tickets",
        "description": "List support tickets (paginated). Returns { results[]{ id, properties{}, ... }, paging }. Useful properties: subject, content, hs_pipeline, hs_pipeline_stage, hs_ticket_priority. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/tickets",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "e.g. ['subject','hs_pipeline_stage','hs_ticket_priority']"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "archived": {
              "type": "boolean"
            }
          }
        }
      },
      {
        "id": "getTicket",
        "label": "Get Ticket",
        "description": "Get one ticket by record id. Returns { id, properties{}, associations{} }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/tickets/{ticketId}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ticketId"
          ],
          "properties": {
            "ticketId": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "archived": {
              "type": "boolean"
            }
          }
        }
      },
      {
        "id": "searchTickets",
        "label": "Search Tickets",
        "description": "Search tickets with filterGroups/sorts/properties/query/limit/after. Common: filter by hs_pipeline_stage or hs_ticket_priority. Returns { total, results[], paging }. Free read.",
        "verb": "POST",
        "path": "/crm/v3/objects/tickets/search",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "filterGroups": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "sorts": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "query": {
              "type": "string"
            },
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            }
          }
        },
        "rateLimit": {
          "rps": 4
        }
      },
      {
        "id": "createTicket",
        "label": "Create Ticket",
        "description": "Create a ticket. Body: { properties:{ subject, hs_pipeline, hs_pipeline_stage, ... }, associations? }. hs_pipeline_stage must be valid for the ticket pipeline (see listTicketPipelines). Returns created { id, properties }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/tickets",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "e.g. { subject, content, hs_pipeline, hs_pipeline_stage, hs_ticket_priority }"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "updateTicket",
        "label": "Update Ticket",
        "description": "Update a ticket by id (e.g. change stage/priority). Body: { properties:{} }. Returns updated record. Write — 1 credit.",
        "verb": "PATCH",
        "path": "/crm/v3/objects/tickets/{ticketId}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ticketId",
            "properties"
          ],
          "properties": {
            "ticketId": {
              "type": "string"
            },
            "properties": {
              "type": "object"
            }
          }
        }
      },
      {
        "id": "archiveTicket",
        "label": "Archive Ticket",
        "description": "Archive (soft-delete) a ticket by id. Returns 204. Write — 1 credit.",
        "verb": "DELETE",
        "path": "/crm/v3/objects/tickets/{ticketId}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ticketId"
          ],
          "properties": {
            "ticketId": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "batchReadTickets",
        "label": "Batch Read Tickets",
        "description": "Read up to 100 tickets by id. Body: { inputs:[{ id }], properties:[] }. Returns { results[] }. 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/tickets/batch/read",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "batchCreateTickets",
        "label": "Batch Create Tickets",
        "description": "Create up to 100 tickets. Body: { inputs:[{ properties:{} }] }. Returns { results[] }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/tickets/batch/create",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "batchUpdateTickets",
        "label": "Batch Update Tickets",
        "description": "Update up to 100 tickets. Body: { inputs:[{ id, properties:{} }] }. Returns { results[] }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/tickets/batch/update",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "inputs"
          ],
          "properties": {
            "inputs": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "listLineItems",
        "label": "List Line Items",
        "description": "List line items (products attached to deals/quotes). Returns { results[]{ id, properties{} }, paging }. Useful properties: name, quantity, price, hs_product_id. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/line_items",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "getLineItem",
        "label": "Get Line Item",
        "description": "Get one line item by record id. Returns { id, properties{} }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/line_items/{lineItemId}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "lineItemId"
          ],
          "properties": {
            "lineItemId": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "createLineItem",
        "label": "Create Line Item",
        "description": "Create a line item. Body: { properties:{ name, price, quantity, hs_product_id? }, associations? } — associate to a deal to add it to that deal. Returns created { id, properties }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/line_items",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "e.g. { name, price, quantity, hs_product_id }"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "listProducts",
        "label": "List Products",
        "description": "List products from the product library. Returns { results[]{ id, properties{} }, paging }. Useful properties: name, price, hs_sku, description. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/products",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "getProduct",
        "label": "Get Product",
        "description": "Get one product by record id. Returns { id, properties{} }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/products/{productId}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "productId"
          ],
          "properties": {
            "productId": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "createProduct",
        "label": "Create Product",
        "description": "Create a product in the product library. Body: { properties:{ name, price, hs_sku?, description? } }. Returns created { id, properties }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/products",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "e.g. { name, price, hs_sku, description }"
            }
          }
        }
      },
      {
        "id": "listQuotes",
        "label": "List Quotes",
        "description": "List quotes. Returns { results[]{ id, properties{} }, paging }. Useful properties: hs_title, hs_status, hs_expiration_date. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/quotes",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "getQuote",
        "label": "Get Quote",
        "description": "Get one quote by record id. Returns { id, properties{} }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/quotes/{quoteId}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "quoteId"
          ],
          "properties": {
            "quoteId": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "createQuote",
        "label": "Create Quote",
        "description": "Create a quote. Body: { properties:{ hs_title, hs_expiration_date, ... }, associations? }. Quotes typically associate to a deal, line items and a quote template. Returns created { id, properties }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/quotes",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "e.g. { hs_title, hs_expiration_date, hs_status }"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "listObjects",
        "label": "List Records (Any Object)",
        "description": "Generic list for ANY object type — standard (contacts/companies/deals/tickets) or a custom object by its objectType/objectTypeId (e.g. 'p_my_object' or '2-12345'). Returns { results[], paging }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/{objectType}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "objectType"
          ],
          "properties": {
            "objectType": {
              "type": "string",
              "description": "Object name or objectTypeId, e.g. 'contacts','companies','tickets','p_pets','2-12345'"
            },
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "archived": {
              "type": "boolean"
            }
          }
        },
        "options": {
          "objectType": {
            "method": "listSchemas",
            "labelKey": "name",
            "valueKey": "fullyQualifiedName",
            "sublabelKey": "objectTypeId",
            "args": {
              "includeStandard": true
            }
          }
        }
      },
      {
        "id": "searchObjects",
        "label": "Search Records (Any Object)",
        "description": "Generic search for ANY object type. Body: filterGroups/sorts/properties/query/limit/after. Path takes the objectType (name or objectTypeId). Returns { total, results[], paging }. Free read.",
        "verb": "POST",
        "path": "/crm/v3/objects/{objectType}/search",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "objectType"
          ],
          "properties": {
            "objectType": {
              "type": "string",
              "description": "Object name or objectTypeId"
            },
            "filterGroups": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "sorts": {
              "type": "array",
              "items": {
                "type": "object"
              }
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "query": {
              "type": "string"
            },
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            }
          }
        },
        "rateLimit": {
          "rps": 4
        },
        "options": {
          "objectType": {
            "method": "listSchemas",
            "labelKey": "name",
            "valueKey": "fullyQualifiedName",
            "sublabelKey": "objectTypeId",
            "args": {
              "includeStandard": true
            }
          }
        }
      },
      {
        "id": "createObject",
        "label": "Create Record (Any Object)",
        "description": "Generic create for ANY object type. Path takes objectType; body { properties:{}, associations? }. Returns created { id, properties }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/{objectType}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "objectType",
            "properties"
          ],
          "properties": {
            "objectType": {
              "type": "string",
              "description": "Object name or objectTypeId"
            },
            "properties": {
              "type": "object"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        },
        "options": {
          "objectType": {
            "method": "listSchemas",
            "labelKey": "name",
            "valueKey": "fullyQualifiedName",
            "sublabelKey": "objectTypeId",
            "args": {
              "includeStandard": true
            }
          }
        }
      },
      {
        "id": "listAssociations",
        "label": "List Associations (v4)",
        "description": "List all records of toObjectType associated with a given record. Returns { results[]{ toObjectId, associationTypes[]{ category, typeId, label } }, paging }. Free read.",
        "verb": "GET",
        "path": "/crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/{toObjectType}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "fromObjectType",
            "fromObjectId",
            "toObjectType"
          ],
          "properties": {
            "fromObjectType": {
              "type": "string",
              "description": "e.g. 'contacts'"
            },
            "fromObjectId": {
              "type": "string",
              "description": "Source record id"
            },
            "toObjectType": {
              "type": "string",
              "description": "e.g. 'companies'"
            },
            "limit": {
              "type": "integer",
              "description": "Max 500 (default 10)"
            },
            "after": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "createDefaultAssociation",
        "label": "Create Default Association (v4)",
        "description": "PUT a default (unlabeled) association between two records — HubSpot picks the standard association type. Path: from/{id}/associations/default/to/{id}. No body needed. Returns the created association. Write — 1 credit.",
        "verb": "PUT",
        "path": "/crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/default/{toObjectType}/{toObjectId}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "fromObjectType",
            "fromObjectId",
            "toObjectType",
            "toObjectId"
          ],
          "properties": {
            "fromObjectType": {
              "type": "string"
            },
            "fromObjectId": {
              "type": "string"
            },
            "toObjectType": {
              "type": "string"
            },
            "toObjectId": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "createLabeledAssociation",
        "label": "Create Labeled Association (v4)",
        "description": "PUT a labeled association between two records. Body is an ARRAY of { associationCategory: 'HUBSPOT_DEFINED'|'USER_DEFINED', associationTypeId }. Use listAssociationLabels to find valid typeIds. Returns the created association. Write — 1 credit.",
        "verb": "PUT",
        "path": "/crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/{toObjectType}/{toObjectId}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "fromObjectType",
            "fromObjectId",
            "toObjectType",
            "toObjectId"
          ],
          "properties": {
            "fromObjectType": {
              "type": "string"
            },
            "fromObjectId": {
              "type": "string"
            },
            "toObjectType": {
              "type": "string"
            },
            "toObjectId": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "deleteAssociation",
        "label": "Delete Association (v4)",
        "description": "DELETE all associations between two specific records (you can't target a single label with v4 — it removes all). Returns 204. Write — 1 credit.",
        "verb": "DELETE",
        "path": "/crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/{toObjectType}/{toObjectId}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "fromObjectType",
            "fromObjectId",
            "toObjectType",
            "toObjectId"
          ],
          "properties": {
            "fromObjectType": {
              "type": "string"
            },
            "fromObjectId": {
              "type": "string"
            },
            "toObjectType": {
              "type": "string"
            },
            "toObjectId": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "listAssociationLabels",
        "label": "List Association Labels (v4 Schema)",
        "description": "List the valid association types/labels between two object types, with their associationTypeId and category. Use these ids in createLabeledAssociation. Returns { results[]{ category, typeId, label } }. Free read.",
        "verb": "GET",
        "path": "/crm/v4/associations/{fromObjectType}/{toObjectType}/labels",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "fromObjectType",
            "toObjectType"
          ],
          "properties": {
            "fromObjectType": {
              "type": "string",
              "description": "e.g. 'contacts'"
            },
            "toObjectType": {
              "type": "string",
              "description": "e.g. 'companies'"
            }
          }
        }
      },
      {
        "id": "listSchemas",
        "label": "List Object Schemas",
        "description": "List object type schemas (custom objects, plus standard when includeStandard=true). Returns { results[]{ objectTypeId, fullyQualifiedName, name, labels{ singular, plural } } }. Use fullyQualifiedName or objectTypeId as the objectType for generic object methods. Free read.",
        "verb": "GET",
        "path": "/crm/v3/schemas",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "includeStandard": {
              "type": "boolean",
              "description": "Include standard object schemas (contacts/companies/deals/tickets) as well as custom (default false)"
            },
            "archived": {
              "type": "boolean"
            }
          }
        }
      },
      {
        "id": "listProperties",
        "label": "List Properties",
        "description": "List all properties defined for an object type (their name, label, type, fieldType, options for enums). Essential for knowing valid property names before reads/writes/searches. Returns { results[] }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/properties/{objectType}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "objectType"
          ],
          "properties": {
            "objectType": {
              "type": "string",
              "description": "e.g. 'contacts','companies','deals','tickets'"
            },
            "archived": {
              "type": "boolean"
            }
          }
        }
      },
      {
        "id": "getProperty",
        "label": "Get Property",
        "description": "Get a single property definition for an object type by property name. Returns { name, label, type, fieldType, options[] }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/properties/{objectType}/{propertyName}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "objectType",
            "propertyName"
          ],
          "properties": {
            "objectType": {
              "type": "string"
            },
            "propertyName": {
              "type": "string",
              "description": "e.g. 'lifecyclestage'"
            }
          }
        }
      },
      {
        "id": "createProperty",
        "label": "Create Property",
        "description": "Create a custom property on an object type. Body: { name, label, type, fieldType, groupName, options? }. type ∈ string|number|date|datetime|enumeration|bool; fieldType ∈ text|textarea|number|select|checkbox|date|... Returns created property. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/properties/{objectType}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "objectType",
            "name",
            "label",
            "type",
            "fieldType",
            "groupName"
          ],
          "properties": {
            "objectType": {
              "type": "string"
            },
            "name": {
              "type": "string",
              "description": "Internal property name (lowercase, no spaces)"
            },
            "label": {
              "type": "string",
              "description": "Human-readable label"
            },
            "type": {
              "type": "string",
              "description": "string | number | date | datetime | enumeration | bool"
            },
            "fieldType": {
              "type": "string",
              "description": "text | textarea | number | select | radio | checkbox | date"
            },
            "groupName": {
              "type": "string",
              "description": "Property group to place it in, e.g. 'contactinformation'"
            },
            "options": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "For enumeration types: [{ label, value, displayOrder }]"
            }
          }
        }
      },
      {
        "id": "listOwners",
        "label": "List Owners",
        "description": "List CRM owners (users who can own records). Returns { results[]{ id, email, firstName, lastName, userId } }. Use the owner `id` to set hubspot_owner_id on a record. Optionally filter by email. Free read.",
        "verb": "GET",
        "path": "/crm/v3/owners",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "email": {
              "type": "string",
              "description": "Filter to the owner with this email"
            },
            "limit": {
              "type": "integer",
              "description": "Max 500 (default 100)"
            },
            "after": {
              "type": "string"
            },
            "archived": {
              "type": "boolean"
            }
          }
        }
      },
      {
        "id": "getOwner",
        "label": "Get Owner",
        "description": "Get one owner by owner id. Returns { id, email, firstName, lastName, userId, teams[] }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/owners/{ownerId}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ownerId"
          ],
          "properties": {
            "ownerId": {
              "type": "string",
              "description": "Owner id (the value used in hubspot_owner_id)"
            }
          }
        },
        "options": {
          "ownerId": {
            "method": "listOwners",
            "labelKey": "email",
            "valueKey": "id",
            "args": {
              "limit": 500
            }
          }
        }
      },
      {
        "id": "listPipelines",
        "label": "List Pipelines",
        "description": "List all pipelines and their stages for an object type (deals or tickets). Returns { results[]{ id, label, stages[]{ id, label, displayOrder, metadata } } }. Use stage ids when setting dealstage/hs_pipeline_stage. Free read.",
        "verb": "GET",
        "path": "/crm/v3/pipelines/{objectType}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "objectType"
          ],
          "properties": {
            "objectType": {
              "type": "string",
              "description": "'deals' or 'tickets'"
            }
          }
        }
      },
      {
        "id": "getPipeline",
        "label": "Get Pipeline",
        "description": "Get one pipeline (and its stages) by id for an object type. Returns { id, label, stages[] }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/pipelines/{objectType}/{pipelineId}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "objectType",
            "pipelineId"
          ],
          "properties": {
            "objectType": {
              "type": "string",
              "description": "'deals' or 'tickets'"
            },
            "pipelineId": {
              "type": "string"
            }
          }
        },
        "options": {
          "pipelineId": {
            "method": "listPipelines",
            "labelKey": "label",
            "valueKey": "id",
            "args": {
              "objectType": "deals"
            }
          }
        }
      },
      {
        "id": "listPipelineStages",
        "label": "List Pipeline Stages",
        "description": "List the stages of a single pipeline. Returns { results[]{ id, label, displayOrder, metadata{ isClosed, probability } } }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/pipelines/{objectType}/{pipelineId}/stages",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "objectType",
            "pipelineId"
          ],
          "properties": {
            "objectType": {
              "type": "string",
              "description": "'deals' or 'tickets'"
            },
            "pipelineId": {
              "type": "string"
            }
          }
        },
        "options": {
          "pipelineId": {
            "method": "listPipelines",
            "labelKey": "label",
            "valueKey": "id",
            "args": {
              "objectType": "deals"
            }
          }
        }
      },
      {
        "id": "listNotes",
        "label": "List Notes",
        "description": "List note engagements. Returns { results[]{ id, properties{ hs_note_body, hs_timestamp } }, paging }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/notes",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "createNote",
        "label": "Create Note",
        "description": "Create a note engagement. Body: { properties:{ hs_note_body, hs_timestamp }, associations? } — associate to a contact/company/deal to log it on that record's timeline. hs_timestamp is epoch ms or ISO. Returns created { id }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/notes",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "{ hs_note_body, hs_timestamp }"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "Associate to the record(s) this note belongs to"
            }
          }
        }
      },
      {
        "id": "listTasks",
        "label": "List Tasks",
        "description": "List task engagements. Returns { results[]{ id, properties{ hs_task_subject, hs_task_status, hs_task_priority, hs_timestamp } }, paging }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/tasks",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "createTask",
        "label": "Create Task",
        "description": "Create a task engagement. Body: { properties:{ hs_task_subject, hs_task_body, hs_task_status, hs_task_priority, hs_timestamp, hubspot_owner_id }, associations? }. Returns created { id }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/tasks",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "{ hs_task_subject, hs_task_status, hs_task_priority, hs_timestamp, hubspot_owner_id }"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "listCalls",
        "label": "List Calls",
        "description": "List call engagements. Returns { results[]{ id, properties{ hs_call_title, hs_call_body, hs_call_duration, hs_timestamp } }, paging }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/calls",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "createCall",
        "label": "Create Call",
        "description": "Log a call engagement. Body: { properties:{ hs_call_title, hs_call_body, hs_call_duration, hs_call_direction, hs_timestamp }, associations? }. Returns created { id }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/calls",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "{ hs_call_title, hs_call_body, hs_call_duration, hs_call_direction, hs_timestamp }"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "listEmails",
        "label": "List Emails",
        "description": "List email engagements (logged emails). Returns { results[]{ id, properties{ hs_email_subject, hs_email_text, hs_timestamp } }, paging }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/emails",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "createEmail",
        "label": "Create Email",
        "description": "Log an email engagement. Body: { properties:{ hs_email_subject, hs_email_text, hs_email_direction, hs_timestamp }, associations? }. Returns created { id }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/emails",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "{ hs_email_subject, hs_email_text, hs_email_direction, hs_timestamp }"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "listMeetings",
        "label": "List Meetings",
        "description": "List meeting engagements. Returns { results[]{ id, properties{ hs_meeting_title, hs_meeting_start_time, hs_meeting_end_time, hs_timestamp } }, paging }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/objects/meetings",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "after": {
              "type": "string"
            },
            "properties": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "id": "createMeeting",
        "label": "Create Meeting",
        "description": "Log a meeting engagement. Body: { properties:{ hs_meeting_title, hs_meeting_body, hs_meeting_start_time, hs_meeting_end_time, hs_timestamp }, associations? }. Returns created { id }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/objects/meetings",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "properties"
          ],
          "properties": {
            "properties": {
              "type": "object",
              "description": "{ hs_meeting_title, hs_meeting_start_time, hs_meeting_end_time, hs_timestamp }"
            },
            "associations": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "createList",
        "label": "Create List",
        "description": "Create a list (segment). Body: { name, objectTypeId (e.g. '0-1' contacts, '0-2' companies), processingType: 'MANUAL'|'SNAPSHOT'|'DYNAMIC', filterBranch? }. Only MANUAL/SNAPSHOT lists accept manual membership changes. Returns { list{ listId, ... } }. Write — 1 credit.",
        "verb": "POST",
        "path": "/crm/v3/lists",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "objectTypeId",
            "processingType"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "objectTypeId": {
              "type": "string",
              "description": "e.g. '0-1' (contacts), '0-2' (companies)"
            },
            "processingType": {
              "type": "string",
              "description": "MANUAL | SNAPSHOT | DYNAMIC"
            },
            "filterBranch": {
              "type": "object",
              "description": "Filter definition for DYNAMIC lists"
            }
          }
        }
      },
      {
        "id": "getList",
        "label": "Get List",
        "description": "Get a list by listId. Returns { list{ listId, name, objectTypeId, processingType, size, ... } }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/lists/{listId}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "listId"
          ],
          "properties": {
            "listId": {
              "type": "string"
            },
            "includeFilters": {
              "type": "boolean",
              "description": "Include the list's filter definition"
            }
          }
        },
        "options": {
          "listId": {
            "method": "searchLists",
            "itemsPath": "lists",
            "labelKey": "name",
            "valueKey": "listId",
            "sublabelKey": "processingType",
            "args": {
              "count": 100
            }
          }
        }
      },
      {
        "id": "searchLists",
        "label": "Search Lists",
        "description": "Search lists by name/type. Body: { query?, processingTypes?[], listIds?[], count?, offset? }. Returns { lists[], total, offset }. Free read.",
        "verb": "POST",
        "path": "/crm/v3/lists/search",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Match against list names"
            },
            "processingTypes": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "MANUAL | SNAPSHOT | DYNAMIC"
            },
            "listIds": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "count": {
              "type": "integer",
              "description": "Page size"
            },
            "offset": {
              "type": "integer"
            }
          }
        },
        "rateLimit": {
          "rps": 4
        }
      },
      {
        "id": "getListMemberships",
        "label": "Get List Memberships",
        "description": "Get the record ids that are members of a list (paginated). Returns { results[]{ recordId, membershipTimestamp }, paging }. Free read.",
        "verb": "GET",
        "path": "/crm/v3/lists/{listId}/memberships",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "listId"
          ],
          "properties": {
            "listId": {
              "type": "string"
            },
            "limit": {
              "type": "integer",
              "description": "Max 250"
            },
            "after": {
              "type": "string"
            }
          }
        },
        "options": {
          "listId": {
            "method": "searchLists",
            "itemsPath": "lists",
            "labelKey": "name",
            "valueKey": "listId",
            "sublabelKey": "processingType",
            "args": {
              "count": 100
            }
          }
        }
      },
      {
        "id": "addListMemberships",
        "label": "Add Records to List",
        "description": "Add records to a MANUAL/SNAPSHOT list. Body is a JSON ARRAY of record ids (strings), e.g. ['101','102']. Returns { recordsIdsAdded[], recordIdsDidNotExist[] }. Write — 1 credit.",
        "verb": "PUT",
        "path": "/crm/v3/lists/{listId}/memberships/add",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "listId"
          ],
          "properties": {
            "listId": {
              "type": "string"
            }
          }
        },
        "options": {
          "listId": {
            "method": "searchLists",
            "itemsPath": "lists",
            "labelKey": "name",
            "valueKey": "listId",
            "sublabelKey": "processingType",
            "args": {
              "count": 100
            }
          }
        }
      },
      {
        "id": "removeListMemberships",
        "label": "Remove Records from List",
        "description": "Remove records from a MANUAL/SNAPSHOT list. Body is a JSON ARRAY of record ids (strings). Returns { recordsIdsRemoved[] }. Write — 1 credit.",
        "verb": "PUT",
        "path": "/crm/v3/lists/{listId}/memberships/remove",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "listId"
          ],
          "properties": {
            "listId": {
              "type": "string"
            }
          }
        },
        "options": {
          "listId": {
            "method": "searchLists",
            "itemsPath": "lists",
            "labelKey": "name",
            "valueKey": "listId",
            "sublabelKey": "processingType",
            "args": {
              "count": 100
            }
          }
        }
      }
    ]
  },
  {
    "id": "instantly",
    "name": "Instantly",
    "version": "1.0.0",
    "category": "outreach",
    "description": "Cold email outreach — push leads into campaigns, verify emails, read analytics.",
    "baseUrl": "https://api.instantly.ai/api/v2",
    "logo": "https://www.google.com/s2/favicons?domain=instantly.ai&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "Authorization",
      "scheme": "Bearer ",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 600,
      "concurrency": 5
    },
    "methods": [
      {
        "id": "listCampaigns",
        "label": "List Campaigns",
        "description": "List campaigns (cursor-paginated). Use next_starting_after to page.",
        "verb": "GET",
        "path": "/campaigns",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "1-100 (default 100)"
            },
            "starting_after": {
              "type": "string",
              "description": "Pagination cursor"
            },
            "search": {
              "type": "string",
              "description": "Filter by campaign name"
            }
          }
        }
      },
      {
        "id": "getCampaign",
        "label": "Get Campaign",
        "description": "Get a campaign by id (UUID).",
        "verb": "GET",
        "path": "/campaigns/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Campaign UUID"
            }
          }
        },
        "options": {
          "id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "createCampaign",
        "label": "Create Campaign",
        "description": "Create a new campaign. Requires `name`; `campaign_schedule` (with at least one named schedule defining timing) is required by the API. Returns the created campaign object including its UUID. Campaign starts paused — call activateCampaign to launch.",
        "verb": "POST",
        "path": "/campaigns",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "name",
            "campaign_schedule"
          ],
          "properties": {
            "name": {
              "type": "string",
              "description": "Campaign name"
            },
            "campaign_schedule": {
              "type": "object",
              "description": "Schedule config: { schedules: [{ name, timing:{from,to}, days:{...}, timezone }] }"
            },
            "email_list": {
              "type": "array",
              "description": "Sending account emails to attach",
              "items": {
                "type": "string"
              }
            },
            "daily_limit": {
              "type": "integer",
              "description": "Max emails/day across the campaign"
            },
            "sequences": {
              "type": "array",
              "description": "Email step sequences",
              "items": {
                "type": "object"
              }
            }
          }
        }
      },
      {
        "id": "updateCampaign",
        "label": "Update Campaign",
        "description": "Patch a campaign by id (name, schedule, daily_limit, sequences, etc.). Returns the updated campaign.",
        "verb": "PATCH",
        "path": "/campaigns/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Campaign UUID"
            },
            "name": {
              "type": "string"
            },
            "daily_limit": {
              "type": "integer"
            },
            "campaign_schedule": {
              "type": "object"
            },
            "sequences": {
              "type": "array",
              "items": {
                "type": "object"
              }
            }
          }
        },
        "options": {
          "id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "deleteCampaign",
        "label": "Delete Campaign",
        "description": "Delete a campaign by id (UUID). Irreversible.",
        "verb": "DELETE",
        "path": "/campaigns/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Campaign UUID"
            }
          }
        },
        "options": {
          "id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "activateCampaign",
        "label": "Activate Campaign",
        "description": "Start or resume a campaign (begins sending). Path id is the campaign UUID; no body required.",
        "verb": "POST",
        "path": "/campaigns/{id}/activate",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Campaign UUID"
            }
          }
        },
        "options": {
          "id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "pauseCampaign",
        "label": "Pause Campaign",
        "description": "Pause a running campaign (stops sending). Path id is the campaign UUID; no body required.",
        "verb": "POST",
        "path": "/campaigns/{id}/pause",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Campaign UUID"
            }
          }
        },
        "options": {
          "id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "searchCampaignsByContact",
        "label": "Find Campaigns for a Contact",
        "description": "Find which campaigns a contact (by email) is enrolled in. Returns the list of campaigns containing that lead. Useful to dedupe before enrolling.",
        "verb": "POST",
        "path": "/campaigns/search-by-contact",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Contact email to search for"
            }
          }
        }
      },
      {
        "id": "createLead",
        "label": "Add Lead to Campaign",
        "description": "Add a contact to a campaign (or list). Only `email` is required; pass `campaign` (the campaign UUID — note: NOT campaign_id) to enroll them. Use skip_if_in_campaign to dedupe.",
        "verb": "POST",
        "path": "/leads",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Contact email (required)"
            },
            "campaign": {
              "type": "string",
              "description": "Campaign UUID to enroll into"
            },
            "list_id": {
              "type": "string",
              "description": "Lead-list UUID (alternative target)"
            },
            "first_name": {
              "type": "string"
            },
            "last_name": {
              "type": "string"
            },
            "company_name": {
              "type": "string"
            },
            "phone": {
              "type": "string"
            },
            "website": {
              "type": "string"
            },
            "custom_variables": {
              "type": "object",
              "description": "Custom personalization variables as a { key: value } map (e.g. { \"icebreaker\": \"{{Opener}}\", \"industry\": \"{{Industry}}\" }). Map a grid column into each value to reference it as {{key}} in your sequence. Add as many as you need. Note: a new key propagates to every lead in the campaign."
            },
            "skip_if_in_campaign": {
              "type": "boolean",
              "description": "Skip if already in the campaign"
            }
          }
        },
        "options": {
          "campaign": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          },
          "list_id": {
            "method": "listLeadLists",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "getLead",
        "label": "Get Lead",
        "description": "Get a single lead by its id (UUID). Returns the full lead object including custom variables, status and campaign membership.",
        "verb": "GET",
        "path": "/leads/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Lead UUID"
            }
          }
        }
      },
      {
        "id": "updateLead",
        "label": "Update Lead",
        "description": "Patch a lead by id — update name, company, custom variables, etc. Returns the updated lead. Note: setting a new custom variable propagates the key to all leads in the campaign.",
        "verb": "PATCH",
        "path": "/leads/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Lead UUID"
            },
            "first_name": {
              "type": "string"
            },
            "last_name": {
              "type": "string"
            },
            "company_name": {
              "type": "string"
            },
            "phone": {
              "type": "string"
            },
            "website": {
              "type": "string"
            },
            "custom_variables": {
              "type": "object",
              "description": "Arbitrary key/value metadata"
            }
          }
        }
      },
      {
        "id": "deleteLead",
        "label": "Delete Lead",
        "description": "Delete a lead by id (UUID). Irreversible.",
        "verb": "DELETE",
        "path": "/leads/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Lead UUID"
            }
          }
        }
      },
      {
        "id": "listLeads",
        "label": "List / Search Leads",
        "description": "Search and page through leads. POST (not GET) because of complex filters. Filter by campaign, list_id, or search string. Returns { items[], next_starting_after }. Order is ascending by lead id; reuse next_starting_after to paginate.",
        "verb": "POST",
        "path": "/leads/list",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "campaign": {
              "type": "string",
              "description": "Filter to a campaign UUID"
            },
            "list_id": {
              "type": "string",
              "description": "Filter to a lead-list UUID"
            },
            "search": {
              "type": "string",
              "description": "Free-text match on email/name/company"
            },
            "limit": {
              "type": "integer",
              "description": "1-100"
            },
            "starting_after": {
              "type": "string",
              "description": "Pagination cursor"
            }
          }
        },
        "options": {
          "campaign": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          },
          "list_id": {
            "method": "listLeadLists",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "bulkAddLeads",
        "label": "Bulk Add Leads",
        "description": "Add many leads at once to a campaign or list. Pass `leads` (array of {email,...}) plus a target `campaign` (UUID) or `list_id`. Returns a background-job handle — poll getBackgroundJob until done. Heavier than createLead.",
        "verb": "POST",
        "path": "/leads/list/add",
        "credits": 2,
        "input": {
          "type": "object",
          "required": [
            "leads"
          ],
          "properties": {
            "leads": {
              "type": "array",
              "description": "Array of lead objects (each needs at least `email`). Run per-row, one lead is built from the mapped columns.",
              "items": {
                "type": "object",
                "required": [
                  "email"
                ],
                "properties": {
                  "email": {
                    "type": "string"
                  },
                  "first_name": {
                    "type": "string"
                  },
                  "last_name": {
                    "type": "string"
                  },
                  "company_name": {
                    "type": "string"
                  },
                  "phone": {
                    "type": "string"
                  },
                  "website": {
                    "type": "string"
                  },
                  "custom_variables": {
                    "type": "object",
                    "description": "Custom personalization variables as a { key: value } map. Map a grid column into each value to reference it as {{key}} in your sequence. Add as many as you need."
                  }
                }
              }
            },
            "campaign": {
              "type": "string",
              "description": "Target campaign UUID"
            },
            "list_id": {
              "type": "string",
              "description": "Target lead-list UUID"
            },
            "skip_if_in_campaign": {
              "type": "boolean",
              "description": "Dedupe against existing campaign members"
            }
          }
        },
        "options": {
          "campaign": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          },
          "list_id": {
            "method": "listLeadLists",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "moveLeads",
        "label": "Move Leads",
        "description": "Move leads between campaigns/lists. Specify the source filter (campaign/list_id/ids) and the destination (to_campaign_id or to_list_id). Returns a background-job handle — poll getBackgroundJob. Heavy/bulk operation.",
        "verb": "POST",
        "path": "/leads/move",
        "credits": 2,
        "input": {
          "type": "object",
          "properties": {
            "ids": {
              "type": "array",
              "description": "Specific lead UUIDs to move",
              "items": {
                "type": "string"
              }
            },
            "campaign": {
              "type": "string",
              "description": "Source campaign UUID"
            },
            "list_id": {
              "type": "string",
              "description": "Source list UUID"
            },
            "to_campaign_id": {
              "type": "string",
              "description": "Destination campaign UUID"
            },
            "to_list_id": {
              "type": "string",
              "description": "Destination list UUID"
            }
          }
        },
        "options": {
          "campaign": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          },
          "list_id": {
            "method": "listLeadLists",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          },
          "to_campaign_id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          },
          "to_list_id": {
            "method": "listLeadLists",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "createLeadList",
        "label": "Create Lead List",
        "description": "Create a new lead list. Requires `name`. Returns the created list including its UUID.",
        "verb": "POST",
        "path": "/lead-lists",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string",
              "description": "Lead-list name"
            }
          }
        }
      },
      {
        "id": "listLeadLists",
        "label": "List Lead Lists",
        "description": "List lead lists (cursor-paginated). Returns { items[], next_starting_after }.",
        "verb": "GET",
        "path": "/lead-lists",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "1-100"
            },
            "starting_after": {
              "type": "string",
              "description": "Pagination cursor"
            }
          }
        }
      },
      {
        "id": "getLeadList",
        "label": "Get Lead List",
        "description": "Get a lead list by id (UUID).",
        "verb": "GET",
        "path": "/lead-lists/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Lead-list UUID"
            }
          }
        },
        "options": {
          "id": {
            "method": "listLeadLists",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "updateLeadList",
        "label": "Update Lead List",
        "description": "Patch a lead list by id (e.g. rename). Returns the updated list.",
        "verb": "PATCH",
        "path": "/lead-lists/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Lead-list UUID"
            },
            "name": {
              "type": "string"
            }
          }
        },
        "options": {
          "id": {
            "method": "listLeadLists",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "deleteLeadList",
        "label": "Delete Lead List",
        "description": "Delete a lead list by id (UUID). Irreversible.",
        "verb": "DELETE",
        "path": "/lead-lists/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Lead-list UUID"
            }
          }
        },
        "options": {
          "id": {
            "method": "listLeadLists",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "verifyEmail",
        "label": "Verify Email",
        "description": "Validate an email address. Returns { verification_status: pending|verified|invalid, catch_all, credits }. May be async — if status is `pending` (verify >10s), poll getEmailVerificationStatus with the same email.",
        "verb": "POST",
        "path": "/email-verification",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string"
            }
          }
        },
        "category": "Verify email",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "getEmailVerificationStatus",
        "label": "Get Email Verification Status",
        "description": "Check the status of a pending email verification job. Path email is URL-encoded. Returns the resolved { verification_status, catch_all }. Use after verifyEmail returns `pending`.",
        "verb": "GET",
        "path": "/email-verification/{email}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "The email previously submitted to verifyEmail"
            }
          }
        },
        "category": "Verify email"
      },
      {
        "id": "listAccounts",
        "label": "List Sending Accounts",
        "description": "List connected sending email accounts (cursor-paginated).",
        "verb": "GET",
        "path": "/accounts",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "1-100"
            },
            "starting_after": {
              "type": "string"
            },
            "search": {
              "type": "string",
              "description": "Filter by email domain"
            }
          }
        }
      },
      {
        "id": "getAccount",
        "label": "Get Sending Account",
        "description": "Get a single sending account by its email address (path param). Returns account config, warmup state and health.",
        "verb": "GET",
        "path": "/accounts/{email}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Sending account email"
            }
          }
        },
        "options": {
          "email": {
            "method": "listAccounts",
            "labelKey": "email",
            "valueKey": "email",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "createAccount",
        "label": "Create Sending Account",
        "description": "Connect a sending email account via IMAP/SMTP. Requires email, first_name, last_name, provider_code and IMAP+SMTP credentials. Returns the created account.",
        "verb": "POST",
        "path": "/accounts",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "email",
            "first_name",
            "last_name",
            "provider_code"
          ],
          "properties": {
            "email": {
              "type": "string"
            },
            "first_name": {
              "type": "string"
            },
            "last_name": {
              "type": "string"
            },
            "provider_code": {
              "type": "integer",
              "description": "Email provider code (e.g. Google=1, custom IMAP)"
            },
            "imap_username": {
              "type": "string"
            },
            "imap_password": {
              "type": "string"
            },
            "imap_host": {
              "type": "string"
            },
            "imap_port": {
              "type": "integer"
            },
            "smtp_username": {
              "type": "string"
            },
            "smtp_password": {
              "type": "string"
            },
            "smtp_host": {
              "type": "string"
            },
            "smtp_port": {
              "type": "integer"
            }
          }
        }
      },
      {
        "id": "updateAccount",
        "label": "Update Sending Account",
        "description": "Patch a sending account by email (e.g. daily limit, warmup, name). Returns the updated account.",
        "verb": "PATCH",
        "path": "/accounts/{email}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Sending account email (path)"
            },
            "first_name": {
              "type": "string"
            },
            "last_name": {
              "type": "string"
            },
            "daily_limit": {
              "type": "integer"
            }
          }
        },
        "options": {
          "email": {
            "method": "listAccounts",
            "labelKey": "email",
            "valueKey": "email",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "deleteAccount",
        "label": "Delete Sending Account",
        "description": "Disconnect/delete a sending account by email. Irreversible.",
        "verb": "DELETE",
        "path": "/accounts/{email}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Sending account email"
            }
          }
        },
        "options": {
          "email": {
            "method": "listAccounts",
            "labelKey": "email",
            "valueKey": "email",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "pauseAccount",
        "label": "Pause Sending Account",
        "description": "Pause sending from an account (path email). No body required.",
        "verb": "POST",
        "path": "/accounts/{email}/pause",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Sending account email"
            }
          }
        },
        "options": {
          "email": {
            "method": "listAccounts",
            "labelKey": "email",
            "valueKey": "email",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "resumeAccount",
        "label": "Resume Sending Account",
        "description": "Resume sending from a paused account (path email). No body required.",
        "verb": "POST",
        "path": "/accounts/{email}/resume",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Sending account email"
            }
          }
        },
        "options": {
          "email": {
            "method": "listAccounts",
            "labelKey": "email",
            "valueKey": "email",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "warmupAnalytics",
        "label": "Get Warmup Analytics",
        "description": "Get warmup deliverability analytics for one or more sending accounts (emails array). Returns per-account warmup health, inbox/spam placement counts.",
        "verb": "POST",
        "path": "/accounts/warmup-analytics",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "emails"
          ],
          "properties": {
            "emails": {
              "type": "array",
              "description": "Sending account emails to report on",
              "items": {
                "type": "string"
              }
            },
            "start_date": {
              "type": "string",
              "description": "YYYY-MM-DD"
            },
            "end_date": {
              "type": "string",
              "description": "YYYY-MM-DD"
            }
          }
        }
      },
      {
        "id": "campaignAnalytics",
        "label": "Get Campaign Analytics",
        "description": "Get analytics for a campaign (sent, opens, clicks, replies, bounces). Omit id for all campaigns.",
        "verb": "GET",
        "path": "/campaigns/analytics",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Campaign UUID (omit for all)"
            },
            "start_date": {
              "type": "string",
              "description": "YYYY-MM-DD"
            },
            "end_date": {
              "type": "string",
              "description": "YYYY-MM-DD"
            }
          }
        },
        "options": {
          "id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "campaignAnalyticsDaily",
        "label": "Get Daily Campaign Analytics",
        "description": "Get day-by-day campaign analytics (sent/opens/replies per day). Optional campaign_id; otherwise aggregates. Good for time-series columns.",
        "verb": "GET",
        "path": "/campaigns/analytics/daily",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "campaign_id": {
              "type": "string",
              "description": "Campaign UUID (omit for all)"
            },
            "start_date": {
              "type": "string",
              "description": "YYYY-MM-DD"
            },
            "end_date": {
              "type": "string",
              "description": "YYYY-MM-DD"
            }
          }
        },
        "options": {
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "campaignAnalyticsSteps",
        "label": "Get Campaign Step Analytics",
        "description": "Get per-sequence-step analytics for a campaign (how each email step performed). Set include_opportunities_count for opportunities per step.",
        "verb": "GET",
        "path": "/campaigns/analytics/steps",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "campaign_id": {
              "type": "string",
              "description": "Campaign UUID"
            },
            "start_date": {
              "type": "string",
              "description": "YYYY-MM-DD"
            },
            "end_date": {
              "type": "string",
              "description": "YYYY-MM-DD"
            },
            "include_opportunities_count": {
              "type": "boolean"
            }
          }
        },
        "options": {
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "listEmails",
        "label": "List Emails",
        "description": "List/search inbox & sent emails (replies, sequence sends). Filter by campaign_id, eaccount (sending account), lead, is_unread, email_type, etc. Cursor-paginated. Returns { items[], next_starting_after }.",
        "verb": "GET",
        "path": "/emails",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "campaign_id": {
              "type": "string",
              "description": "Filter to a campaign UUID"
            },
            "eaccount": {
              "type": "string",
              "description": "Filter to a sending account email"
            },
            "lead": {
              "type": "string",
              "description": "Filter to a lead email"
            },
            "is_unread": {
              "type": "boolean"
            },
            "email_type": {
              "type": "string",
              "description": "e.g. 'received' | 'sent'"
            },
            "limit": {
              "type": "integer",
              "description": "1-100"
            },
            "starting_after": {
              "type": "string",
              "description": "Pagination cursor"
            }
          }
        },
        "options": {
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          },
          "eaccount": {
            "method": "listAccounts",
            "labelKey": "email",
            "valueKey": "email",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "getEmail",
        "label": "Get Email",
        "description": "Get a single email by its id (UUID). Returns full message incl. body, thread_id, lead/account.",
        "verb": "GET",
        "path": "/emails/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Email UUID"
            }
          }
        }
      },
      {
        "id": "replyToEmail",
        "label": "Reply to Email",
        "description": "Send a reply within an existing thread. Set reply_to_uuid to the id of an email returned by listEmails/getEmail, plus eaccount (sending account), subject and body. Returns the sent email.",
        "verb": "POST",
        "path": "/emails/reply",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "reply_to_uuid",
            "eaccount",
            "body"
          ],
          "properties": {
            "reply_to_uuid": {
              "type": "string",
              "description": "id of the email to reply to"
            },
            "eaccount": {
              "type": "string",
              "description": "Sending account email to send from"
            },
            "subject": {
              "type": "string"
            },
            "body": {
              "type": "object",
              "description": "{ html: '...', text: '...' }"
            }
          }
        },
        "options": {
          "eaccount": {
            "method": "listAccounts",
            "labelKey": "email",
            "valueKey": "email",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "countUnreadEmails",
        "label": "Count Unread Emails",
        "description": "Get the count of unread emails in the unibox. Returns { count }.",
        "verb": "GET",
        "path": "/emails/unread/count",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "markThreadAsRead",
        "label": "Mark Thread as Read",
        "description": "Mark all emails in a thread as read. Path thread_id from an email's thread_id field. No body required.",
        "verb": "POST",
        "path": "/emails/threads/{thread_id}/mark-as-read",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "thread_id"
          ],
          "properties": {
            "thread_id": {
              "type": "string",
              "description": "Email thread id"
            }
          }
        }
      },
      {
        "id": "listBackgroundJobs",
        "label": "List Background Jobs",
        "description": "List background jobs (bulk operations like bulkAddLeads/moveLeads). Filter by status/type. Returns { items[] }.",
        "verb": "GET",
        "path": "/background-jobs",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "status": {
              "type": "string",
              "description": "e.g. 'pending' | 'success' | 'failed'"
            },
            "type": {
              "type": "string"
            },
            "limit": {
              "type": "integer"
            },
            "starting_after": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "getBackgroundJob",
        "label": "Get Background Job",
        "description": "Poll a background job by id (UUID) to check progress/result of a bulk operation (bulkAddLeads, moveLeads, etc.). Returns { status, progress, ... }.",
        "verb": "GET",
        "path": "/background-jobs/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Background job UUID"
            }
          }
        }
      }
    ]
  },
  {
    "id": "leadmagic",
    "name": "LeadMagic",
    "version": "1.0.0",
    "category": "enrichment",
    "description": "B2B data enrichment — email finder, mobile finder, and profile & company search.",
    "baseUrl": "https://api.leadmagic.io",
    "auth": {
      "type": "apiKey",
      "header": "X-API-Key",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 300,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "emailFinder",
        "label": "Find Email",
        "description": "Find a person's work email from their name and company. Needs a name (first_name+last_name OR full_name) AND a company (domain OR company_name). Returns { email, status, employment_verified, company_name }. 1 credit per valid email; free if not found.",
        "verb": "POST",
        "path": "/v1/people/email-finder",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "first_name": {
              "type": "string",
              "description": "First name"
            },
            "last_name": {
              "type": "string",
              "description": "Last name"
            },
            "full_name": {
              "type": "string",
              "description": "Full name (alternative to first+last)"
            },
            "domain": {
              "type": "string",
              "description": "Company website domain, e.g. 'stripe.com'"
            },
            "company_name": {
              "type": "string",
              "description": "Company name (alternative to domain)"
            }
          }
        },
        "category": "Find email"
      },
      {
        "id": "emailValidation",
        "label": "Validate Email",
        "description": "Validate an email address and return deliverability + company data. Returns { email, email_status, is_domain_catch_all, company_name, company_industry }. 0.25 credit for definitive valid/invalid.",
        "verb": "POST",
        "path": "/v1/people/email-validation",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Email address to validate"
            }
          }
        },
        "category": "Verify email"
      },
      {
        "id": "mobileFinder",
        "label": "Find Mobile",
        "description": "Find a person's mobile phone number. Provide at least one of profile_url, work_email, personal_email. Returns { mobile_number, profile_url, email }. 5 credits on success; free if none found.",
        "verb": "POST",
        "path": "/v1/people/mobile-finder",
        "credits": 5,
        "input": {
          "type": "object",
          "properties": {
            "profile_url": {
              "type": "string",
              "description": "LinkedIn profile URL"
            },
            "work_email": {
              "type": "string",
              "description": "Work email"
            },
            "personal_email": {
              "type": "string",
              "description": "Personal email"
            }
          }
        },
        "category": "Find phone"
      },
      {
        "id": "profileSearch",
        "label": "Enrich LinkedIn Profile",
        "description": "Enrich a LinkedIn profile from its URL. Returns { full_name, professional_title, bio, location, company_name, company_industry, work_experience[], education[] }. 1 credit on success.",
        "verb": "POST",
        "path": "/v1/people/profile-search",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "profile_url"
          ],
          "properties": {
            "profile_url": {
              "type": "string",
              "description": "LinkedIn profile URL or username"
            },
            "extended_response": {
              "type": "boolean",
              "description": "Return extended fields (default false)"
            }
          }
        },
        "category": "Enrich people",
        "rateLimit": {
          "rpm": 100
        }
      },
      {
        "id": "b2bProfile",
        "label": "Email to LinkedIn Profile",
        "description": "Reverse-lookup a LinkedIn profile from a work or personal email. Returns { profile_url }. 10 credits on success; free if no match.",
        "verb": "POST",
        "path": "/v1/people/b2b-profile",
        "credits": 10,
        "input": {
          "type": "object",
          "properties": {
            "work_email": {
              "type": "string",
              "description": "Work email (preferred)"
            },
            "personal_email": {
              "type": "string",
              "description": "Personal email"
            }
          }
        },
        "category": "Enrich people"
      },
      {
        "id": "socialToWorkEmail",
        "label": "LinkedIn Profile to Work Email",
        "description": "Reverse of b2bProfile: get a person's verified work email from their LinkedIn/B2B profile URL. Returns { email, profile_url, credits_consumed, message }. 5 credits on success; free if no result.",
        "verb": "POST",
        "path": "/v1/people/b2b-profile-email",
        "credits": 5,
        "input": {
          "type": "object",
          "required": [
            "profile_url"
          ],
          "properties": {
            "profile_url": {
              "type": "string",
              "description": "LinkedIn/B2B profile URL or username, e.g. 'linkedin.com/in/johndoe'"
            }
          }
        },
        "category": "Find email"
      },
      {
        "id": "personalEmailFinder",
        "label": "Find Personal Email",
        "description": "Find a person's personal email(s) (Gmail/Outlook/iCloud) from their LinkedIn/B2B profile URL. Returns { profile_url, first_personal_email, personal_emails[], name, credits_consumed, message }. 2 credits if found; free if none.",
        "verb": "POST",
        "path": "/v1/people/personal-email-finder",
        "credits": 2,
        "input": {
          "type": "object",
          "required": [
            "profile_url"
          ],
          "properties": {
            "profile_url": {
              "type": "string",
              "description": "Professional/LinkedIn profile URL or username"
            }
          }
        },
        "category": "Find email"
      },
      {
        "id": "companySearch",
        "label": "Enrich Company",
        "description": "Enrich a company from its domain, name, or LinkedIn URL. Returns camelCase fields: { companyName, industry, employeeCount, employeeRange, founded, headquarters, revenue, description, specialties[] }. 1 credit on success.",
        "verb": "POST",
        "path": "/v1/companies/company-search",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Company website domain"
            },
            "company_name": {
              "type": "string",
              "description": "Company name"
            },
            "profile_url": {
              "type": "string",
              "description": "Company LinkedIn URL"
            }
          }
        },
        "category": "Enrich company",
        "rateLimit": {
          "rpm": 100
        }
      },
      {
        "id": "companyFunding",
        "label": "Company Funding",
        "description": "Get a company's funding history, financials, investors and CEO details. Provide company_domain (preferred) OR company_name. Returns { company_name, total_funding, latest_round, latest_round_amount, latest_round_date, funding_rounds[], investors[], lead_investors[], leadership.ceo{ firstName, lastName, designation, b2b_profile }, credits_consumed, message }. 4 credits on success; free if no funding data.",
        "verb": "POST",
        "path": "/v1/companies/company-funding",
        "credits": 4,
        "input": {
          "type": "object",
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Company website domain (preferred)"
            },
            "company_name": {
              "type": "string",
              "description": "Company name (alternative to domain)"
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "roleFinder",
        "label": "Find Person by Role",
        "description": "Find a person holding a given job title at a company. Requires company_domain OR company_name; job_title is optional (partial match). Returns { first_name, last_name, full_name, job_title, company_name, company_website, profile_url, credits_consumed, message }. 2 credits if found; free if no match.",
        "verb": "POST",
        "path": "/v1/people/role-finder",
        "credits": 2,
        "input": {
          "type": "object",
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Company website domain"
            },
            "company_name": {
              "type": "string",
              "description": "Company name"
            },
            "job_title": {
              "type": "string",
              "description": "Target job title (partial match), e.g. 'VP of Sales'"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "employeeFinder",
        "label": "Find Company Employees",
        "description": "List employees at a company. Requires company_domain OR company_name; optional limit (default 10). Returns { employees[]{ first_name, last_name, full_name, job_title, location, profile_url }, total_count, credits_consumed, message }. 0.05 credit per employee returned.",
        "verb": "POST",
        "path": "/v1/people/employee-finder",
        "credits": 2,
        "input": {
          "type": "object",
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Company website domain"
            },
            "company_name": {
              "type": "string",
              "description": "Company name"
            },
            "limit": {
              "type": "integer",
              "description": "Max employees to return (default 10)"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "jobChangeDetector",
        "label": "Detect Job Change",
        "description": "Check whether a person has changed jobs from a known company. Provide profile_url plus the expected company_domain OR company_name. Returns { job_changed, still_employed, current_company, current_title }. 3 credits per call.",
        "verb": "POST",
        "path": "/v1/people/job-change-detector",
        "credits": 3,
        "input": {
          "type": "object",
          "required": [
            "profile_url"
          ],
          "properties": {
            "profile_url": {
              "type": "string",
              "description": "LinkedIn profile URL"
            },
            "company_domain": {
              "type": "string",
              "description": "Expected (known) company domain"
            },
            "company_name": {
              "type": "string",
              "description": "Expected (known) company name"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "jobsFinder",
        "label": "Search Job Postings",
        "description": "Search live job postings with company, role, location and date filters (intent/hiring signal). All params optional. Returns { total_count, page, per_page, total_pages, credits_consumed, results[]{ title, company info, location, types, experience level, remote status, publish date, description, application URL } }. 1 credit per job returned. Use jobCountries/jobTypes to resolve filter IDs first.",
        "verb": "POST",
        "path": "/v1/jobs/jobs-finder",
        "credits": 2,
        "input": {
          "type": "object",
          "properties": {
            "company_name": {
              "type": "string",
              "description": "Filter by company name"
            },
            "company_website": {
              "type": "string",
              "description": "Filter by company website/domain"
            },
            "company_type_id": {
              "type": "integer",
              "description": "Company type filter ID"
            },
            "company_industry_id": {
              "type": "integer",
              "description": "Company industry filter ID"
            },
            "min_employees": {
              "type": "integer",
              "description": "Minimum company headcount"
            },
            "max_employees": {
              "type": "integer",
              "description": "Maximum company headcount"
            },
            "job_title": {
              "type": "string",
              "description": "Filter by job title"
            },
            "job_description": {
              "type": "string",
              "description": "Filter by text in job description"
            },
            "experience_level": {
              "type": "string",
              "description": "One of: entry, mid, senior, executive"
            },
            "job_type_id": {
              "type": "integer",
              "description": "Job type filter ID (see jobTypes)"
            },
            "has_remote": {
              "type": "boolean",
              "description": "Only remote jobs"
            },
            "location": {
              "type": "string",
              "description": "Free-text location"
            },
            "city_name": {
              "type": "string",
              "description": "City name"
            },
            "country_id": {
              "type": "string",
              "description": "Country filter ID (see jobCountries)"
            },
            "region_id": {
              "type": "integer",
              "description": "Region/state filter ID"
            },
            "posted_within": {
              "type": "integer",
              "description": "Jobs posted within the last N days"
            },
            "posted_after": {
              "type": "string",
              "description": "Jobs posted on/after date (YYYY-MM-DD)"
            },
            "posted_before": {
              "type": "string",
              "description": "Jobs posted on/before date (YYYY-MM-DD)"
            },
            "page": {
              "type": "integer",
              "description": "Page number (default 1)"
            },
            "per_page": {
              "type": "integer",
              "description": "Results per page (default 20, max 50)"
            }
          }
        },
        "category": "Jobs",
        "rateLimit": {
          "rpm": 100
        },
        "options": {
          "country_id": {
            "method": "jobCountries",
            "labelKey": "name",
            "valueKey": "id"
          },
          "job_type_id": {
            "method": "jobTypes",
            "labelKey": "name",
            "valueKey": "id"
          },
          "region_id": {
            "method": "jobRegions",
            "labelKey": "name",
            "valueKey": "id"
          },
          "company_industry_id": {
            "method": "jobIndustries",
            "labelKey": "name",
            "valueKey": "id"
          },
          "company_type_id": {
            "method": "jobCompanyTypes",
            "labelKey": "name",
            "valueKey": "id"
          }
        }
      },
      {
        "id": "jobCountries",
        "label": "List Job Countries",
        "description": "List supported country filter IDs for jobsFinder. No inputs. Returns an array of { id, name }. Free — cache locally.",
        "verb": "GET",
        "path": "/v1/jobs/countries",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        },
        "category": "Jobs"
      },
      {
        "id": "jobTypes",
        "label": "List Job Types",
        "description": "List supported job_type_id values for jobsFinder (e.g. Full Time=1, Part Time=2, Temporary=3, Internship=4, Freelance=5, Contract=6). No inputs. Returns an array of { id, name }. Free — cache locally.",
        "verb": "GET",
        "path": "/v1/jobs/job-types",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        },
        "category": "Jobs"
      },
      {
        "id": "googleAdsSearch",
        "label": "Search Google Ads",
        "description": "Find a company's active Google Ads creatives (ad-spend / GTM intel). Requires company_domain (preferred) OR company_name. Returns { ads_count, ads[]{ advertiser_id, creative_id, original_url, variants[], start, last_seen, advertiser_name, format }, credits_consumed, message }. 0.2 credit per search; free if no results.",
        "verb": "POST",
        "path": "/v1/ads/google-ads-search",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Company website domain (preferred), e.g. 'gong.io'"
            },
            "company_name": {
              "type": "string",
              "description": "Company name (alternative to domain)"
            }
          }
        },
        "category": "Ads"
      },
      {
        "id": "metaAdsSearch",
        "label": "Search Meta Ads",
        "description": "Find a company's active Meta (Facebook/Instagram) Ads from the Facebook Ad Library. Requires company_domain OR company_name. Returns { ads_count, ads[], credits_consumed, message }. 0.2 credit per search; free if no results.",
        "verb": "POST",
        "path": "/v1/ads/meta-ads-search",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Company website domain"
            },
            "company_name": {
              "type": "string",
              "description": "Company name"
            }
          }
        },
        "category": "Ads"
      },
      {
        "id": "b2bAdsSearch",
        "label": "Search B2B (LinkedIn) Ads",
        "description": "Find a company's B2B / LinkedIn ad creatives. Requires company_domain OR company_name. Returns { ads_count, ads[]{ content, link, image_url }, credits_consumed, message }. Use b2bAdDetails with an ad link/ID for full creative copy.",
        "verb": "POST",
        "path": "/v1/ads/b2b-ads-search",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Company website domain"
            },
            "company_name": {
              "type": "string",
              "description": "Company name"
            }
          }
        },
        "category": "Ads"
      },
      {
        "id": "b2bAdDetails",
        "label": "Get B2B Ad Details",
        "description": "Resolve full creative detail for a single B2B ad returned by b2bAdsSearch. Requires ad_url (the Ad Library URL or ID). Returns { ad_details{ ads_type, content, heading, cta{ title, url } }, credits_consumed, message }. 2 credits per resolved ad; free if not found.",
        "verb": "POST",
        "path": "/v1/ads/b2b-ads-details",
        "credits": 2,
        "input": {
          "type": "object",
          "required": [
            "ad_url"
          ],
          "properties": {
            "ad_url": {
              "type": "string",
              "description": "Ad Library URL or ID (from b2bAdsSearch results)"
            }
          }
        },
        "category": "Ads"
      },
      {
        "id": "checkCredits",
        "label": "Check Credits",
        "description": "Get the current LeadMagic credit balance. Returns { credits }. Free.",
        "verb": "GET",
        "path": "/v1/credits",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "analytics",
        "label": "Analytics Dashboard",
        "description": "Free real-time account snapshot: current credit balance, rate-limit utilization, concurrency metrics, and request/credit usage stats for today/this week/this month. Returns { user, credits, rate_limit, concurrency, stats }. GET, no parameters, 0 credits.",
        "verb": "GET",
        "path": "/v1/analytics/dashboard",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "companyLookalike",
        "label": "Find Lookalike Companies",
        "description": "Find companies semantically similar to a seed for ICP expansion. Provide exactly one seed: company_domain (or domain), website, company_name, or description. Optionally narrow with company_filters (geo, headcount, industry, tech stack, funding) and paginate with limit/offset; set preview=true for a free count-only run. Returns per-match { similarity, company_domain, company_name, employee_range, revenue_range, founded_year, industry, hq_country/city/state, total_funding, last_funding_date, lead_investors, crm_tech/marketing_automation_tech/analytics_tech, total_contacts, contacts_with_email, valid_email_count } plus source_seed_domain. 1 credit per lookalike returned; free when zero matches or preview=true.",
        "verb": "POST",
        "path": "/v3/companies/lookalike",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Seed company domain, e.g. 'stripe.com' (preferred seed input; alias of 'domain')"
            },
            "domain": {
              "type": "string",
              "description": "Seed company domain (alias of company_domain)"
            },
            "website": {
              "type": "string",
              "description": "Seed company full URL or bare domain"
            },
            "company_name": {
              "type": "string",
              "description": "Seed company name (text-intent fallback)"
            },
            "description": {
              "type": "string",
              "description": "Free-text semantic seed describing the target company profile"
            },
            "company_filters": {
              "type": "object",
              "description": "Optional filters: geography, headcount, industry, tech stack, funding criteria"
            },
            "preview": {
              "type": "boolean",
              "description": "If true, returns count only and spends no credits"
            },
            "limit": {
              "type": "integer",
              "description": "Max results, range 1-2000, default 25"
            },
            "offset": {
              "type": "integer",
              "description": "Pagination offset"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "companySearchV3",
        "label": "Search Companies (V3)",
        "description": "Canonical company discovery: single-company lookup (provide one of company_domain / website / company_name / linkedin_url) OR criteria-based discovery via company_filters (industries, country_codes, headcount/revenue/funding ranges, technographics, founded-year range). Supports limit/offset pagination and a preview flag that returns match counts without spending credits. Direct lookup returns { found, company, companyName, companyDomain, websiteUrl, linkedinUrl }; broad search returns { companies[] } with firmographics, HQ location, funding/investors, social metrics, contact coverage, technographics, SIC/NAICS classifications. 1 credit per company returned; free when zero matches or when preview=true.",
        "verb": "POST",
        "path": "/v3/companies/search",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Company domain for single-company lookup, e.g. 'stripe.com' (one of company_domain/website/company_name/linkedin_url)"
            },
            "website": {
              "type": "string",
              "description": "Company website URL for single-company lookup (alternative lookup key)"
            },
            "company_name": {
              "type": "string",
              "description": "Company name for single-company lookup (alternative lookup key)"
            },
            "linkedin_url": {
              "type": "string",
              "description": "Company LinkedIn profile URL for single-company lookup (alternative lookup key)"
            },
            "company_filters": {
              "type": "object",
              "description": "Criteria-based discovery filters: company_domains (string[]), country_codes (string[]), industries (string[]), headcount_ranges (array), crm_tech/marketing_tech/analytics_tech (technographics), founded_year_min/founded_year_max (int), revenue_ranges (array), funding_stages (array)"
            },
            "limit": {
              "type": "integer",
              "description": "Results per page"
            },
            "offset": {
              "type": "integer",
              "description": "Pagination offset"
            },
            "preview": {
              "type": "boolean",
              "description": "If true, returns match counts without spending credits"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "competitorsSearch",
        "label": "Find Competitors",
        "description": "Find a company's competitors from a company identifier. Provide at least one of company_domain, company_url, or company_name. Returns { company_name, competitors[] (name, domain, profile_url, industry, employee_count, description), credits_consumed, message }. 5 credits per successful search; free if no competitors found.",
        "verb": "POST",
        "path": "/v1/companies/competitors-search",
        "credits": 5,
        "input": {
          "type": "object",
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Company website domain, e.g. 'salesforce.com' (provide one of company_domain/company_url/company_name)"
            },
            "company_url": {
              "type": "string",
              "description": "Company website URL (alternative to company_domain)"
            },
            "company_name": {
              "type": "string",
              "description": "Company name (alternative to company_domain)"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "technographics",
        "label": "Get Technographics",
        "description": "Analyze a company's website to detect its technology stack (marketing, analytics, hosting, CRM, CDN, etc.) from a company_domain. Returns { company_domain, technologies (name/category/website/icon), categories (grouped by type), credits_consumed, message }. 1 credit per company if technologies are found; free if no results.",
        "verb": "POST",
        "path": "/v1/companies/technographics",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "company_domain"
          ],
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Company website domain to analyze, e.g. 'stripe.com'"
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "peopleSearch",
        "label": "People Search",
        "description": "Unified V3 people lookup: find people by company (company_domain OR company_name OR linkedin_url OR company_filters) plus optional people_filters (name, title, function, level, location, industry, follower/seniority ranges, email/mobile availability) and title/role intent. Returns { message, people[] (with nested company + domain_intel), count, returned_count, credits_consumed }. 1 credit per returned person, free if no results; +1/raw email and +5/raw mobile when include_contact_details:true (needs confirm_credit_charge).",
        "verb": "POST",
        "path": "/v3/people/search",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "company_domain": {
              "type": "string",
              "description": "Company website domain to target, e.g. 'stripe.com'. One company identifier required."
            },
            "company_name": {
              "type": "string",
              "description": "Company name to target. Alternative company identifier."
            },
            "linkedin_url": {
              "type": "string",
              "description": "Company LinkedIn URL to target. Alternative company identifier."
            },
            "company_filters": {
              "type": "object",
              "description": "Object of company-level filters for broad multi-company discovery; usable in place of a single company identifier."
            },
            "title": {
              "type": "string",
              "description": "Target job title (alias: job_title)."
            },
            "job_title": {
              "type": "string",
              "description": "Target job title (alias of title)."
            },
            "titles": {
              "type": "array",
              "description": "Array of target job titles."
            },
            "roles": {
              "type": "array",
              "description": "Array of target roles."
            },
            "query": {
              "type": "string",
              "description": "Free-text people intent query."
            },
            "people_filters": {
              "type": "object",
              "description": "Nested object of people-level filters: full/first/last name, email domain, LinkedIn URL/username, job title, function, level, location (country, region, city, state), LinkedIn headline/about, industry, job description, languages, follower ranges, seniority score, email/mobile availability flags."
            },
            "required_email": {
              "type": "boolean",
              "description": "Only return people with an available email."
            },
            "required_mobile": {
              "type": "boolean",
              "description": "Only return people with an available mobile."
            },
            "include_contact_details": {
              "type": "boolean",
              "description": "Unlock raw contact details (emails/mobiles); incurs extra credits per unlock."
            },
            "confirm_credit_charge": {
              "type": "boolean",
              "description": "Required to confirm paid contact-detail unlocks when include_contact_details is true."
            },
            "limit": {
              "type": "integer",
              "description": "Max people to return; max 100, default 25."
            },
            "offset": {
              "type": "integer",
              "description": "Pagination offset."
            },
            "include_company": {
              "type": "boolean",
              "description": "Include nested company data in each result."
            },
            "person_fields": {
              "type": "string",
              "description": "Field set per person: 'summary' or 'full'."
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "jobCompanyTypes",
        "label": "Job Company Types",
        "description": "Catalog of company type classifications (e.g. public, private, nonprofit) used to filter Jobs Finder results via the company_type_id parameter. Returns the list of { id, name } company types. Free helper endpoint — cache results locally; no credits charged. Takes no input.",
        "verb": "GET",
        "path": "/v1/jobs/company-types",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        },
        "category": "Jobs"
      },
      {
        "id": "jobIndustries",
        "label": "List Job Industries",
        "description": "Catalog endpoint returning the list of job/company industry categories and their IDs. Use the returned company_industry_id to filter the Jobs Finder and other targeting endpoints. Takes no parameters; returns an array of { id, name } industry records. Free helper endpoint — no credits charged; cache results locally.",
        "verb": "GET",
        "path": "/v1/jobs/industries",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        },
        "category": "Jobs"
      },
      {
        "id": "jobRegions",
        "label": "Job Regions",
        "description": "List supported regions/states for job-search geographic targeting. Free catalog endpoint, no inputs. Returns an array of { id, name, country_id }; use the returned region id as region_id in the Jobs Finder API and pair with country_id for precise targeting.",
        "verb": "GET",
        "path": "/v1/jobs/regions",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        },
        "category": "Jobs"
      },
      {
        "id": "jobSearch",
        "label": "Search Jobs",
        "description": "Search live job postings with frontend-friendly filters; resolves company domains, country codes, tags, occupation taxonomy, and title terms into normalized filter IDs before running a bounded query. All filters optional. Returns { signals[] (title, company, location, salary, posted_at, has_remote, application_url, occupation_taxonomy), total, pagination.next_cursor, credits_consumed }. 1 credit per returned job; free if none returned; dryRun validates without charging.",
        "verb": "POST",
        "path": "/v3/jobs/search",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "titles": {
              "type": "object",
              "description": "Title filter: { include: string[], exclude: string[], vector: boolean (semantic title matching) }"
            },
            "occupationTaxonomy": {
              "type": "object",
              "description": "Normalized occupation filter: { level1, level2, level3 } each string[] or int[] (broad family / mid-level / specific title)"
            },
            "companies": {
              "type": "object",
              "description": "Company filter: { include: string[] (domains or names), exclude: string[], ids: int[] (exact company IDs) }"
            },
            "location": {
              "type": "object",
              "description": "Location filter: { countries, regions, states, cities } each string[] or int[] (names, codes, or IDs)"
            },
            "tags": {
              "type": "object",
              "description": "Tag filter: { include, exclude } each string[] or int[] (tag names or IDs)"
            },
            "salary": {
              "type": "object",
              "description": "Normalized USD salary filter: { min_usd: integer, max_usd: integer }"
            },
            "seniority": {
              "type": "array",
              "description": "Experience levels: EN, MI, SE, EX"
            },
            "languages": {
              "type": "array",
              "description": "Two-letter language codes"
            },
            "hasRemote": {
              "type": "boolean",
              "description": "Filter for remote-work support"
            },
            "workModes": {
              "type": "array",
              "description": "Work mode IDs (1, 2, 3)"
            },
            "jobTypeIds": {
              "type": "array",
              "description": "Job type IDs from catalog"
            },
            "industryIds": {
              "type": "array",
              "description": "Company industry IDs"
            },
            "companyTypeIds": {
              "type": "array",
              "description": "Company type IDs"
            },
            "companySizeCodes": {
              "type": "array",
              "description": "Company size bucket codes"
            },
            "postedAfter": {
              "type": "string",
              "description": "YYYY-MM-DD; jobs posted on/after this date"
            },
            "postedBefore": {
              "type": "string",
              "description": "YYYY-MM-DD; jobs posted before/on this date"
            },
            "postedWithin": {
              "type": "integer",
              "description": "Jobs posted within the last N days"
            },
            "includeAgencies": {
              "type": "boolean",
              "description": "Include staffing/recruiting agencies"
            },
            "limit": {
              "type": "integer",
              "description": "Number of jobs to return (max 50)"
            },
            "pagination": {
              "type": "object",
              "description": "Cursor object from a prior response's pagination.next_cursor"
            },
            "includeDescription": {
              "type": "boolean",
              "description": "Include job description snippet in results"
            },
            "includeCompany": {
              "type": "boolean",
              "description": "Include company object in results"
            },
            "includeFacets": {
              "type": "boolean",
              "description": "Include facet metadata"
            },
            "includeOccupationTaxonomy": {
              "type": "boolean",
              "description": "Include occupation taxonomy fields in results"
            },
            "totalMode": {
              "type": "string",
              "description": "Count mode: 'none', 'capped', or 'exact'"
            },
            "mode": {
              "type": "string",
              "description": "Query mode: 'fast' (default) or 'deep'"
            },
            "dryRun": {
              "type": "boolean",
              "description": "Validate the query without charging credits"
            },
            "autoResolve": {
              "type": "boolean",
              "description": "Resolve friendly strings (domains, names) into filter IDs before search"
            },
            "_query_budget_ms": {
              "type": "integer",
              "description": "Internal query budget hint in milliseconds"
            }
          }
        },
        "category": "Jobs"
      },
      {
        "id": "jobSearchCatalogs",
        "label": "Job Search Catalogs",
        "description": "Catalog/helper endpoint returning all job-search filter taxonomies in one call: countries, regions, job_types, industries, company_types, seniority levels, and dataset stats. Takes no parameters. Use to populate static filter dropdowns. Free; 0 credits.",
        "verb": "GET",
        "path": "/v3/jobs/search/catalogs",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        },
        "category": "Jobs"
      },
      {
        "id": "jobSearchCompanies",
        "label": "Job Search Companies",
        "description": "Resolve a free-text company name or domain into canonical company IDs for use as Job Search filters (autocomplete/filter-builder helper). Pass q (name or domain) and/or domain (exact). Returns { companies: [{ id, name, domain, logo_domain }] }. Free, 0 credits.",
        "verb": "GET",
        "path": "/v3/jobs/search/companies",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "q": {
              "type": "string",
              "description": "Free-text company name or domain to search for, e.g. 'leadmagic'"
            },
            "domain": {
              "type": "string",
              "description": "Exact company domain lookup, e.g. 'leadmagic.io'"
            },
            "limit": {
              "type": "integer",
              "description": "Max number of company candidates to return"
            }
          }
        },
        "category": "Jobs"
      },
      {
        "id": "jobSearchHelpers",
        "label": "Resolve Job Search Filters",
        "description": "Resolve friendly job-search filter values (company names/domains, tags, titles, occupation taxonomy, locations) into canonical LeadMagic filter IDs before running a job search. POST body groups inputs by filter category, each with include/exclude sub-arrays. Returns each input value replaced by { id, name, ... } canonical objects, plus a `warnings` array for any unresolved values. Free helper endpoint. Companion GET autocomplete helpers (all also free, /v3/jobs/search/{companies,tags,titles,occupation-taxonomy,locations,catalogs}?q=) provide per-field lookups.",
        "verb": "POST",
        "path": "/v3/jobs/search/resolve",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "companies": {
              "type": "object",
              "description": "Company filters to resolve: { include, exclude, ids } (names or domains, e.g. 'leadmagic.io')"
            },
            "tags": {
              "type": "object",
              "description": "Tag filters to resolve: { include, exclude }"
            },
            "occupationTaxonomy": {
              "type": "object",
              "description": "Occupation taxonomy filters to resolve: { level1, level2, level3 }"
            },
            "location": {
              "type": "object",
              "description": "Location filters to resolve: { countries, regions, states, cities }"
            },
            "titles": {
              "type": "object",
              "description": "Job title filters to resolve: { include, exclude }"
            }
          }
        },
        "category": "Jobs"
      },
      {
        "id": "jobSearchLocations",
        "label": "Job Search Locations",
        "description": "Resolve a free-text location query into canonical location IDs for job-search geo filtering. Requires q (e.g. 'Berlin', 'United') AND type (one of country/region/state/city). Returns { locations: [{ id, name, type }] }. Free helper/catalog endpoint, 0 credits.",
        "verb": "GET",
        "path": "/v3/jobs/search/locations",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "q",
            "type"
          ],
          "properties": {
            "q": {
              "type": "string",
              "description": "Free-text location query, e.g. 'United', 'Berlin', 'California'"
            },
            "type": {
              "type": "string",
              "description": "Location type to search. One of 'country', 'region', 'state', or 'city'"
            },
            "limit": {
              "type": "integer",
              "description": "Max number of location candidates to return (optional)"
            }
          }
        },
        "category": "Jobs"
      },
      {
        "id": "jobSearchOccupations",
        "label": "Job Search Occupation Taxonomy",
        "description": "Autocomplete occupation taxonomy: maps free-text occupation input to standardized IDs/labels across a 3-tier hierarchy (level1 families, level2 categories, level3 normalized titles). Requires q (search query); optional level filter and limit. Returns { occupation_taxonomy: [{ id, name, type, level1, level2, level3, path }], credits_consumed: 0 }. Free (0 credits).",
        "verb": "GET",
        "path": "/v3/jobs/search/occupation-taxonomy",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "q"
          ],
          "properties": {
            "q": {
              "type": "string",
              "description": "Free-text occupation search query, e.g. 'DevOps'"
            },
            "level": {
              "type": "string",
              "description": "Optional. Filter by taxonomy level: 'level1', 'level2', or 'level3'"
            },
            "limit": {
              "type": "integer",
              "description": "Optional. Number of results to return"
            }
          }
        },
        "category": "Jobs"
      },
      {
        "id": "jobSearchTags",
        "label": "Job Search Tags",
        "description": "Tag autocomplete for the Job Search filter builder. Free-text query `q` returns normalized hiring-signal tags (tools/platforms/skills, e.g. kubernetes, terraform, react); optionally scope by tag_type_id and cap with limit. Returns { tags: [{ id, name, tag_type, occupation_taxonomy }] }. Free (0 credits).",
        "verb": "GET",
        "path": "/v3/jobs/search/tags",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "q"
          ],
          "properties": {
            "q": {
              "type": "string",
              "description": "Free-text tag query, e.g. 'kuber' matches 'kubernetes', 'kubectl'"
            },
            "tag_type_id": {
              "type": "integer",
              "description": "Optional tag-type ID to scope the search"
            },
            "limit": {
              "type": "integer",
              "description": "Number of tag candidates to return"
            }
          }
        },
        "category": "Jobs"
      },
      {
        "id": "jobSearchTitles",
        "label": "Job Search Titles",
        "description": "Title autocomplete + occupation taxonomy helper for the Job Search filters. Takes a free-text title query `q` (and optional `limit`); returns { titles: [{ id, name, occupation_taxonomy }] } with hierarchical taxonomy metadata. Use to resolve title filters before running a Job Search. Free / 0 credits.",
        "verb": "GET",
        "path": "/v3/jobs/search/titles",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "q"
          ],
          "properties": {
            "q": {
              "type": "string",
              "description": "Free-text title query, e.g. 'devops engineer' (required)"
            },
            "limit": {
              "type": "integer",
              "description": "Max number of title candidates to return (optional)"
            }
          }
        },
        "category": "Jobs"
      },
      {
        "id": "searchStats",
        "label": "Search Stats",
        "description": "Free helper endpoint summarizing what's available across Jobs, Company, and People Search. Powers filter builders, capability cards, and onboarding/\"what can I target?\" UIs. Requires products[] (jobs|company|people) and sections[] (coverage|top|capabilities); optional limit (top values per dimension, default 3, max 25). Returns cached high-level metrics: per-product coverage, top, capabilities blocks plus cache status. credits_consumed always 0.",
        "verb": "POST",
        "path": "/v3/search/stats",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "products",
            "sections"
          ],
          "properties": {
            "products": {
              "type": "array",
              "description": "Required. Product families to include: 'jobs', 'company', 'people'"
            },
            "sections": {
              "type": "array",
              "description": "Required. Sections to include: 'coverage', 'top', 'capabilities'"
            },
            "limit": {
              "type": "integer",
              "description": "Optional. Number of top values per dimension (default 3, max 25)"
            }
          }
        }
      }
    ]
  },
  {
    "id": "plusvibe",
    "name": "PlusVibe",
    "version": "1.0.0",
    "category": "outreach",
    "description": "Cold email at scale — manage campaigns, push leads, read stats. Most calls need workspace_id.",
    "baseUrl": "https://api.plusvibe.ai/api/v1",
    "logo": "https://www.google.com/s2/favicons?domain=plusvibe.ai&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "x-api-key",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rps": 5,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "listWorkspaces",
        "label": "List Workspaces",
        "description": "Authenticate the API key and list the workspaces it can access. Returns { status, workspaces:[{ _id, name }] }. Use this first to resolve a workspace_id. No params besides the API key.",
        "verb": "GET",
        "path": "/authenticate",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "listCampaigns",
        "label": "List Campaigns",
        "description": "List campaigns in a workspace (newest first). Returns an array of campaign objects (id, name, status, sequence steps, sent/opened/replied counts). Requires workspace_id.",
        "verb": "GET",
        "path": "/campaign/list-all",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string",
              "description": "Workspace id (required on almost every call)"
            },
            "campaign_id": {
              "type": "string",
              "description": "Filter by a single campaign id"
            },
            "parent_camp_id": {
              "type": "string",
              "description": "Filter by parent campaign id"
            },
            "status": {
              "type": "string",
              "description": "ACTIVE | PAUSED | COMPLETED | ARCHIVED"
            },
            "campaign_type": {
              "type": "string",
              "description": "all | parent | subseq"
            },
            "skip": {
              "type": "integer",
              "description": "Records to skip (default 0)"
            },
            "limit": {
              "type": "integer",
              "description": "Max records (default 10, max 100)"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "parent_camp_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "createCampaign",
        "label": "Create Campaign",
        "description": "Create a new empty campaign. Returns { status, _id } where _id is the new campaign id. Requires workspace_id + camp_name.",
        "verb": "POST",
        "path": "/campaign/add/campaign",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "camp_name"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "camp_name": {
              "type": "string",
              "description": "Campaign name"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          }
        }
      },
      {
        "id": "getCampaignStatus",
        "label": "Get Campaign Status",
        "description": "Get the run status of a single campaign. Returns { campaign_id, status } (e.g. ACTIVE, PAUSED). Requires workspace_id + campaign_id.",
        "verb": "GET",
        "path": "/campaign/get/status",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "campaign_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "campaign_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "activateCampaign",
        "label": "Activate Campaign",
        "description": "Launch/activate (start sending) a campaign. Returns { status: 'success' }. Requires workspace_id + campaign_id in the body.",
        "verb": "POST",
        "path": "/campaign/launch",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "campaign_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "campaign_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "pauseCampaign",
        "label": "Pause Campaign",
        "description": "Pause a running campaign (stops sending). Returns { status: 'success' }. Requires workspace_id + campaign_id in the body.",
        "verb": "POST",
        "path": "/campaign/pause",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "campaign_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "campaign_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "addLeads",
        "label": "Add Leads to Campaign",
        "description": "Add leads to a campaign. `leads` is an array; each lead supports email, first_name, last_name, notes, address_line, city, country, country_code, phone_number, company_name, company_website, linkedin_person_url, linkedin_company_url, custom_variables. Returns { status, leads_uploaded, duplicate_email_count, already_in_campaign, invalid_email_count, skipped, remaining_in_plan }. Requires workspace_id + campaign_id + leads.",
        "verb": "POST",
        "path": "/lead/add",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "campaign_id",
            "leads"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "campaign_id": {
              "type": "string"
            },
            "leads": {
              "type": "array",
              "description": "Array of leads. Run per-row, one lead is built from the mapped columns.",
              "items": {
                "type": "object",
                "required": [
                  "email"
                ],
                "properties": {
                  "email": {
                    "type": "string"
                  },
                  "first_name": {
                    "type": "string"
                  },
                  "last_name": {
                    "type": "string"
                  },
                  "company_name": {
                    "type": "string"
                  },
                  "company_website": {
                    "type": "string"
                  },
                  "phone_number": {
                    "type": "string"
                  },
                  "linkedin_person_url": {
                    "type": "string"
                  },
                  "linkedin_company_url": {
                    "type": "string"
                  },
                  "address_line": {
                    "type": "string"
                  },
                  "city": {
                    "type": "string"
                  },
                  "country": {
                    "type": "string"
                  },
                  "country_code": {
                    "type": "string"
                  },
                  "notes": {
                    "type": "string"
                  },
                  "custom_variables": {
                    "type": "object",
                    "description": "Custom personalization variables as a { key: value } map. Map a grid column into each value to reference it as a merge tag in your sequence. Add as many as you need."
                  }
                }
              }
            },
            "skip_if_in_workspace": {
              "type": "boolean",
              "description": "Skip leads already present anywhere in the workspace"
            },
            "skip_lead_in_active_pause_camp": {
              "type": "boolean",
              "description": "Skip leads already in an active or paused campaign"
            },
            "skip_lead_for_active_only_camp": {
              "type": "boolean",
              "description": "Skip leads already in an active campaign"
            },
            "resume_camp_if_completed": {
              "type": "boolean"
            },
            "is_overwrite": {
              "type": "boolean",
              "description": "Overwrite existing lead data for matching emails"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        },
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "getLead",
        "label": "Get / Search Lead",
        "description": "Look up a single lead by email (optionally scoped to a campaign). Returns the lead object: { id, campaign, status, contact, email_opened, email_replied, lead_data{...}, campaign_name }. Requires workspace_id + email.",
        "verb": "GET",
        "path": "/lead/get",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "email"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "email": {
              "type": "string",
              "description": "Lead's email address"
            },
            "campaign_id": {
              "type": "string",
              "description": "Omit to search all campaigns"
            },
            "skip": {
              "type": "integer",
              "description": "Pagination offset (min 0)"
            },
            "limit": {
              "type": "integer",
              "description": "Results per page (1-100)"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "workspaceLeads",
        "label": "List Workspace Leads",
        "description": "List/search leads across a workspace. Filter by campaign_id, status, label, email, first_name, last_name. Returns paginated lead objects. Requires workspace_id.",
        "verb": "GET",
        "path": "/lead/workspace-leads",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "campaign_id": {
              "type": "string"
            },
            "status": {
              "type": "string",
              "description": "NOT_CONTACTED | CONTACTED | COMPLETED | REPLIED | BOUNCED | UNSUBSCRIBED | RESCHEDULED | SKIPPED | PENDING"
            },
            "label": {
              "type": "string",
              "description": "INTERESTED | NOT_INTERESTED | custom label"
            },
            "email": {
              "type": "string"
            },
            "first_name": {
              "type": "string"
            },
            "last_name": {
              "type": "string"
            },
            "page": {
              "type": "integer"
            },
            "limit": {
              "type": "integer"
            },
            "sort": {
              "type": "string",
              "description": "Field to sort by"
            },
            "direction": {
              "type": "string",
              "description": "asc | desc"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "updateLeadData",
        "label": "Update Lead Variables / Label",
        "description": "Update or add custom variables (and label) on a lead, keyed by email. `variables` is a key-value object merged into the lead's data. Returns { status: 'success' }. Requires workspace_id + email + variables.",
        "verb": "POST",
        "path": "/lead/data/update",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "email",
            "variables"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "email": {
              "type": "string",
              "description": "Lead's email address"
            },
            "variables": {
              "type": "object",
              "description": "Key-value custom fields to set/add (may include label)"
            },
            "campaign_id": {
              "type": "string",
              "description": "Optional campaign scope"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "updateLeadStatus",
        "label": "Update Lead Status",
        "description": "Mark a lead as COMPLETED in a campaign (only COMPLETED is accepted). Returns { status: 'success' }. Requires workspace_id + campaign_id + email + new_status='COMPLETED'.",
        "verb": "POST",
        "path": "/lead/update/status",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "campaign_id",
            "email",
            "new_status"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "campaign_id": {
              "type": "string"
            },
            "email": {
              "type": "string"
            },
            "new_status": {
              "type": "string",
              "description": "Must be 'COMPLETED'"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "deleteLeads",
        "label": "Delete Leads",
        "description": "Remove leads from a campaign (or workspace) by email. `delete_list` is an array of emails. Returns { status: 'success' }. Requires workspace_id + delete_list.",
        "verb": "POST",
        "path": "/lead/delete",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "delete_list"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "delete_list": {
              "type": "array",
              "description": "Email addresses to remove (min 1)",
              "items": {
                "type": "string"
              }
            },
            "campaign_id": {
              "type": "string"
            },
            "delete_all_from_company": {
              "type": "boolean",
              "description": "Remove all leads sharing the same domain"
            },
            "delete_parent_lead": {
              "type": "boolean",
              "description": "Default true; set false for subsequence leads"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "leadStatusCounts",
        "label": "Lead Counts by Status",
        "description": "Get lead counts grouped by status for a workspace (optionally one campaign). Returns an array of { status, count }. Requires workspace_id.",
        "verb": "GET",
        "path": "/lead/count/lead-status",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "campaign_id": {
              "type": "string",
              "description": "Optional campaign filter"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "campaignSummary",
        "label": "Campaign Summary",
        "description": "Lifetime summary for one campaign. Returns { campaign_id, campaign_name, completed, contacted, leads_who_read, leads_who_replied, bounced, unsubscribed }. Requires workspace_id + campaign_id.",
        "verb": "GET",
        "path": "/analytics/campaign/summary",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "campaign_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "campaign_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "campaignStats",
        "label": "Campaign Stats",
        "description": "Per-campaign analytics over a date range. Omit campaign_id for all campaigns. Returns objects with lead_count, sent_count, unique_opened_count, replied_count, bounced_count, unsubscribed_count, positive_reply_count, opportunity_val. Requires workspace_id + start_date.",
        "verb": "GET",
        "path": "/analytics/campaign/stats",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "start_date"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "campaign_id": {
              "type": "string",
              "description": "Omit for all campaigns"
            },
            "start_date": {
              "type": "string",
              "description": "Period start, e.g. 2024-01-01"
            },
            "end_date": {
              "type": "string",
              "description": "Period end, e.g. 2024-03-14"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "allCampaignsStats",
        "label": "All Campaigns Statistics",
        "description": "Aggregated totals across every campaign in a workspace over a date range. Returns { lead_count, completed_lead_count, sent_count, replied_count, positive_reply_count, bounced_count, unsubscribed_count, unique_opened_count, opportunity_val, lead_contacted_count }. Requires workspace_id + start_date + end_date.",
        "verb": "GET",
        "path": "/campaign/stats/all",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "start_date",
            "end_date"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "start_date": {
              "type": "string",
              "description": "e.g. 2024-01-01"
            },
            "end_date": {
              "type": "string",
              "description": "e.g. 2024-03-14"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          }
        }
      },
      {
        "id": "listEmailAccounts",
        "label": "List Email Accounts",
        "description": "List sending email accounts in a workspace. Returns { accounts:[{ id, email, status, warmup status, provider, daily limits, health score, reply rate }] }. Requires workspace_id.",
        "verb": "GET",
        "path": "/account/list",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "email": {
              "type": "string",
              "description": "Filter by email address"
            },
            "tags": {
              "type": "string",
              "description": "Comma-separated tag ids"
            },
            "skip": {
              "type": "integer"
            },
            "limit": {
              "type": "integer"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "tags": {
            "method": "listTags",
            "labelKey": "name",
            "valueKey": "_id",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "checkAccountVitals",
        "label": "Check Account Vitals (SPF/DKIM/DMARC)",
        "description": "Validate SPF, DKIM and DMARC for sending domains. `accounts` is an array of email addresses. Returns { status, success_list:[{ domain, allPass, spf, dkim, dmarc }], failure_list }. Requires workspace_id + accounts.",
        "verb": "POST",
        "path": "/account/test/vitals",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "accounts"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "accounts": {
              "type": "array",
              "description": "Email addresses to test",
              "items": {
                "type": "string"
              }
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          }
        }
      },
      {
        "id": "uniboxEmails",
        "label": "Get Unibox Emails",
        "description": "List inbox/sent emails (the unified inbox). Filter by lead email, campaign_id, email_type, label. Returns { page_trail, data:[{ id, message_id, subject, from, to, timestamp, preview, body, labels, thread }] }. Requires workspace_id. Use page_trail to paginate.",
        "verb": "GET",
        "path": "/unibox/emails",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "lead": {
              "type": "string",
              "description": "Filter to a specific lead email"
            },
            "campaign_id": {
              "type": "string"
            },
            "email_type": {
              "type": "string",
              "description": "all | received | sent"
            },
            "label": {
              "type": "string",
              "description": "Label in CAPS_WITH_UNDERSCORES"
            },
            "preview_only": {
              "type": "boolean",
              "description": "Return only the content preview"
            },
            "page_trail": {
              "type": "string",
              "description": "Pagination token from a previous response"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "unreadCount",
        "label": "Unread Email Count",
        "description": "Count of unread emails in the workspace inbox. Returns { count }. Requires workspace_id.",
        "verb": "GET",
        "path": "/unibox/emails/count/unread",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          }
        }
      },
      {
        "id": "replyEmail",
        "label": "Reply to Email",
        "description": "Send a reply to an existing thread. Body accepts HTML. Returns { status: 'success', id }. Requires workspace_id (query) + reply_to_id + subject + from + to + body. Include 'Re: ' in subject to keep the thread.",
        "verb": "POST",
        "path": "/unibox/emails/reply",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "reply_to_id",
            "subject",
            "from",
            "to",
            "body"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "reply_to_id": {
              "type": "string",
              "description": "Email id being replied to"
            },
            "subject": {
              "type": "string"
            },
            "from": {
              "type": "string",
              "description": "Sender address (must be a connected account)"
            },
            "to": {
              "type": "string",
              "description": "Recipient address"
            },
            "body": {
              "type": "string",
              "description": "HTML or text body"
            },
            "cc": {
              "type": "string"
            },
            "bcc": {
              "type": "string"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "from": {
            "method": "listEmailAccounts",
            "itemsPath": "accounts",
            "labelKey": "email",
            "valueKey": "email",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        },
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "listBlocklist",
        "label": "List Blocklist",
        "description": "List blocklisted emails/domains in a workspace. Returns entries [{ _id, value, created_by_label, created_at }]. Requires workspace_id.",
        "verb": "GET",
        "path": "/blocklist/list",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "skip": {
              "type": "integer",
              "description": "Default 0"
            },
            "limit": {
              "type": "integer",
              "description": "Default 100"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          }
        }
      },
      {
        "id": "addBlocklist",
        "label": "Add to Blocklist",
        "description": "Add emails or domains to the suppression blocklist. `entries` is an array of strings. Returns { status, entries_added, already_in_blocklist }. Requires workspace_id + entries.",
        "verb": "POST",
        "path": "/blocklist/add/entries",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "entries"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "entries": {
              "type": "array",
              "description": "Emails or domains to blocklist",
              "items": {
                "type": "string"
              }
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          }
        }
      },
      {
        "id": "listTags",
        "label": "List Tags",
        "description": "List tags in a workspace. Returns an array of { _id, name, color, description, status }. Use tag ids to filter email accounts. Requires workspace_id.",
        "verb": "GET",
        "path": "/tags/list",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "skip": {
              "type": "integer"
            },
            "limit": {
              "type": "integer"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          }
        }
      },
      {
        "id": "listWebhooks",
        "label": "List Webhooks",
        "description": "List webhooks configured in a workspace. Returns { hooks:[{ _id, url, name, camp_ids, event_types, status }] }. Requires workspace_id.",
        "verb": "GET",
        "path": "/hook/list",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          }
        }
      },
      {
        "id": "addWebhook",
        "label": "Add Webhook",
        "description": "Register a webhook for campaign events (e.g. LEAD_MARKED_AS_INTERESTED, ALL_EMAIL_REPLIES). camp_ids can be ['ALL']. Returns { status, _id }. Requires workspace_id + name + url + camp_ids + event_types.",
        "verb": "POST",
        "path": "/hook/add",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "workspace_id",
            "name",
            "url",
            "camp_ids",
            "event_types"
          ],
          "properties": {
            "workspace_id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "url": {
              "type": "string",
              "description": "Destination endpoint for events"
            },
            "camp_ids": {
              "type": "array",
              "description": "Campaign ids, or ['ALL']",
              "items": {
                "type": "string"
              }
            },
            "event_types": {
              "type": "array",
              "description": "e.g. ALL_EMAIL_REPLIES, LEAD_MARKED_AS_INTERESTED",
              "items": {
                "type": "string"
              }
            },
            "secret": {
              "type": "string",
              "description": "Signing secret for payload verification"
            },
            "ignore_ooo": {
              "type": "integer",
              "description": "1 to exclude out-of-office replies"
            },
            "ignore_automatic": {
              "type": "integer",
              "description": "1 to exclude automatic replies"
            }
          }
        },
        "options": {
          "workspace_id": {
            "method": "listWorkspaces",
            "itemsPath": "workspaces",
            "labelKey": "name",
            "valueKey": "_id"
          },
          "camp_ids": {
            "method": "listCampaigns",
            "labelKey": "camp_name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      }
    ]
  },
  {
    "id": "prospeo",
    "name": "Prospeo",
    "version": "1.0.0",
    "category": "enrichment",
    "description": "Email & mobile finder — enrich a person to a verified work email and direct phone.",
    "baseUrl": "https://api.prospeo.io",
    "logo": "https://www.google.com/s2/favicons?domain=prospeo.io&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "X-KEY",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 300,
      "rps": 5,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "enrichPerson",
        "label": "Enrich Person",
        "description": "Find a verified work email (and optional mobile) plus full B2B data for one person. Put identifiers inside `data`: { linkedin_url } OR { email } OR { person_id } OR { full_name + a company field } OR { first_name + last_name + a company field } where a company field is company_name | company_website | company_linkedin_url. Returns { error, free_enrichment, person, company }. Set enrich_mobile:true to also reveal a direct mobile (10 credits if found). Costs 1 credit when an email is found, 0 if no match or re-enriched within 90 days.",
        "verb": "POST",
        "path": "/enrich-person",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {
              "type": "object",
              "description": "Identifiers. e.g. { \"linkedin_url\": \"https://linkedin.com/in/...\" } or { \"first_name\": \"Jane\", \"last_name\": \"Doe\", \"company_website\": \"acme.com\" }",
              "properties": {
                "first_name": {
                  "type": "string"
                },
                "last_name": {
                  "type": "string"
                },
                "full_name": {
                  "type": "string"
                },
                "company_name": {
                  "type": "string"
                },
                "company_website": {
                  "type": "string"
                },
                "company_linkedin_url": {
                  "type": "string"
                },
                "linkedin_url": {
                  "type": "string"
                },
                "email": {
                  "type": "string"
                },
                "person_id": {
                  "type": "string",
                  "description": "Person id returned by Search Person"
                }
              }
            },
            "only_verified_email": {
              "type": "boolean",
              "description": "Only return the email if it is verified"
            },
            "enrich_mobile": {
              "type": "boolean",
              "description": "Also attempt to reveal a direct mobile number (10 credits if found)"
            },
            "only_verified_mobile": {
              "type": "boolean",
              "description": "Only return the mobile if it is verified"
            }
          }
        },
        "category": "Enrich people"
      },
      {
        "id": "bulkEnrichPerson",
        "label": "Bulk Enrich People",
        "description": "Enrich up to 50 people in one call. `data` is an array; each item has an `identifier` (your own tracking string, echoed back) plus the same matching datapoints as Enrich Person (linkedin_url | email | person_id | full_name+company | first_name+last_name+company). Returns { error, total_cost, matched:[{ identifier, person, company }], not_matched:[identifier], invalid_datapoints:[identifier] }. Same per-match credit cost as Enrich Person.",
        "verb": "POST",
        "path": "/bulk-enrich-person",
        "credits": 2,
        "input": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {
              "type": "array",
              "description": "Up to 50 person records, each with an identifier plus matching datapoints",
              "items": {
                "type": "object",
                "required": [
                  "identifier"
                ],
                "properties": {
                  "identifier": {
                    "type": "string",
                    "description": "Your own unique tracking string, echoed back in the response"
                  },
                  "first_name": {
                    "type": "string"
                  },
                  "last_name": {
                    "type": "string"
                  },
                  "full_name": {
                    "type": "string"
                  },
                  "company_name": {
                    "type": "string"
                  },
                  "company_website": {
                    "type": "string"
                  },
                  "company_linkedin_url": {
                    "type": "string"
                  },
                  "linkedin_url": {
                    "type": "string"
                  },
                  "email": {
                    "type": "string"
                  },
                  "person_id": {
                    "type": "string"
                  }
                }
              }
            },
            "only_verified_email": {
              "type": "boolean"
            },
            "enrich_mobile": {
              "type": "boolean",
              "description": "Also attempt to reveal mobiles (10 credits per mobile found)"
            },
            "only_verified_mobile": {
              "type": "boolean"
            }
          }
        },
        "category": "Enrich people"
      },
      {
        "id": "enrichCompany",
        "label": "Enrich Company",
        "description": "Enrich one company with firmographics, funding, technologies and job postings. Put identifiers inside `data`: company_website (preferred) OR company_linkedin_url OR company_id OR company_name (least reliable alone). Returns { error, free_enrichment, company } where company has { company_id, name, domain, industry, employee_count, employee_range, location, revenue_range, founded, keywords, funding, technology, job_postings }. 1 credit per match; 0 if no match or re-enriched within 90 days.",
        "verb": "POST",
        "path": "/enrich-company",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {
              "type": "object",
              "description": "Company identifiers. e.g. { \"company_website\": \"intercom.com\" }",
              "properties": {
                "company_website": {
                  "type": "string",
                  "description": "Domain, e.g. 'intercom.com'"
                },
                "company_linkedin_url": {
                  "type": "string",
                  "description": "e.g. 'https://linkedin.com/company/deloitte'"
                },
                "company_name": {
                  "type": "string",
                  "description": "Discouraged as the sole identifier"
                },
                "company_id": {
                  "type": "string",
                  "description": "Company id from a previous enrichment or Search Company"
                }
              }
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "bulkEnrichCompany",
        "label": "Bulk Enrich Companies",
        "description": "Enrich up to 50 companies in one call. `data` is an array; each item has an `identifier` (your own tracking string) plus company_website | company_linkedin_url | company_id | company_name. Returns { error, total_cost, matched:[{ identifier, company }], not_matched:[identifier], invalid_datapoints:[identifier] }. 1 credit per matched company.",
        "verb": "POST",
        "path": "/bulk-enrich-company",
        "credits": 2,
        "input": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {
              "type": "array",
              "description": "Up to 50 company records, each with an identifier plus at least one datapoint",
              "items": {
                "type": "object",
                "required": [
                  "identifier"
                ],
                "properties": {
                  "identifier": {
                    "type": "string",
                    "description": "Your own unique tracking string, echoed back in the response"
                  },
                  "company_website": {
                    "type": "string"
                  },
                  "company_linkedin_url": {
                    "type": "string"
                  },
                  "company_name": {
                    "type": "string"
                  },
                  "company_id": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "searchPerson",
        "label": "Search People",
        "description": "Search Prospeo's 200M+ contact database with 30+ filters (job title, seniority, department, location, company size/industry, technologies, etc.). Returns { error, free, results:[{ person, company }], pagination:{ current_page, per_page, total_page, total_count } }. 25 results per page, max 1,000 pages. Email/mobile are NOT included — feed each result's person_id into Enrich Person to reveal contact info. 1 credit per page returned (free if same filters+page repeated within 30 days). Build filter values with Search Suggestions first.",
        "verb": "POST",
        "path": "/search-person",
        "credits": 1,
        "rateLimit": {
          "rps": 1,
          "rpm": 30
        },
        "input": {
          "type": "object",
          "required": [
            "filters"
          ],
          "properties": {
            "filters": {
              "type": "object",
              "description": "Filter object (job_title, seniority, department, location, company filters, etc.). Use Search Suggestions to get canonical filter values. Cannot use only exclude filters."
            },
            "page": {
              "type": "integer",
              "description": "Page number, defaults to 1. Max 1,000."
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "searchCompany",
        "label": "Search Companies",
        "description": "Search Prospeo's 30M+ company database by firmographic filters (industry, size, location, technologies, funding, etc.). Returns { error, free, results:[{ company }], pagination:{ current_page, per_page, total_page, total_count } }. 25 per page, max 1,000 pages (25,000 companies). 1 credit per page returned (free if same filters+page repeated within 30 days). Websites/names filter lists are capped at 500 items.",
        "verb": "POST",
        "path": "/search-company",
        "credits": 1,
        "rateLimit": {
          "rps": 1,
          "rpm": 30
        },
        "input": {
          "type": "object",
          "required": [
            "filters"
          ],
          "properties": {
            "filters": {
              "type": "object",
              "description": "Company filter object (industry, employee_count, location, technologies, funding, etc.). Use Search Suggestions for canonical values. Cannot use only exclude filters."
            },
            "page": {
              "type": "integer",
              "description": "Page number, defaults to 1. Max 1,000."
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "searchSuggestions",
        "label": "Search Suggestions",
        "description": "FREE helper that resolves canonical filter values for Search People / Search Companies. Provide exactly ONE search field (min 2 chars): location_search, job_title_search, technology_search, industry_search, naics_search, or sic_search. Returns { error, location_suggestions, job_title_suggestions, technology_suggestions, industry_suggestions, naics_suggestions, sic_suggestions } — only the matching field is populated, others are null. 0 credits.",
        "verb": "POST",
        "path": "/search-suggestions",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "location_search": {
              "type": "string",
              "description": "Find canonical location values"
            },
            "job_title_search": {
              "type": "string",
              "description": "Find job title suggestions"
            },
            "technology_search": {
              "type": "string",
              "description": "Find technology names"
            },
            "industry_search": {
              "type": "string",
              "description": "Find industry suggestions"
            },
            "naics_search": {
              "type": "string",
              "description": "Find NAICS codes (numeric or text)"
            },
            "sic_search": {
              "type": "string",
              "description": "Find SIC codes (numeric or text)"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "accountInformation",
        "label": "Account Information",
        "description": "Get plan and credit usage. Returns { error, response: { current_plan, current_team_members, remaining_credits, used_credits, next_quota_renewal_days, next_quota_renewal_date } }. Free.",
        "verb": "GET",
        "path": "/account-information",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      }
    ]
  },
  {
    "id": "reoon",
    "name": "Reoon",
    "version": "1.0.0",
    "category": "enrichment",
    "description": "Email verification — validate deliverability with quick or deep (power) checks.",
    "baseUrl": "https://emailverifier.reoon.com/api/v1",
    "logo": "https://www.google.com/s2/favicons?domain=reoon.com&sz=128",
    "auth": {
      "type": "apiKey",
      "query": "key",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 120,
      "concurrency": 5
    },
    "methods": [
      {
        "id": "verify",
        "label": "Verify Email",
        "description": "Verify a single email address. mode 'quick' is instant (~0.5s) syntax/MX/disposable checks; mode 'power' does deep SMTP/inbox/catch-all checks (slower, more accurate). Returns { status, overall_score, is_safe_to_send, is_deliverable, is_valid_syntax, is_disposable, is_role_account, is_free_email, mx_accepts_mail, can_connect_smtp, is_catch_all, mx_records, ... }. status is one of 'valid' | 'invalid' | 'disabled' | 'unknown' | 'catch_all' | 'spamtrap'.",
        "verb": "GET",
        "path": "/verify",
        "credits": 1,
        "rateLimit": {
          "concurrency": 5
        },
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Email address to verify"
            },
            "mode": {
              "type": "string",
              "description": "quick | power (default quick). power = deep SMTP/inbox verification"
            }
          }
        },
        "category": "Verify email"
      },
      {
        "id": "createBulkTask",
        "label": "Create Bulk Verification Task",
        "description": "Submit up to 50,000 emails for asynchronous batch verification. Duplicates are removed automatically. Returns { status, task_id, count_submitted, count_duplicates_removed, count_rejected_emails, count_processing }. Save task_id, then poll getBulkResult until status is 'completed'. Bulk runs in power mode.",
        "verb": "POST",
        "path": "/create-bulk-verification-task/",
        "credits": 3,
        "rateLimit": {
          "rps": 1
        },
        "input": {
          "type": "object",
          "required": [
            "emails"
          ],
          "properties": {
            "emails": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Array of email addresses (max 50,000)"
            },
            "name": {
              "type": "string",
              "description": "Optional task name, max 25 characters"
            }
          }
        },
        "category": "Verify email"
      },
      {
        "id": "getBulkResult",
        "label": "Get Bulk Verification Result",
        "description": "Retrieve progress and per-email results for a bulk task created by createBulkTask. Returns { task_id, name, status, count_total, count_checked, progress_percentage, results }. status is 'running' until done then 'completed'; poll until then. results is an object keyed by email with the per-email verification fields (status, is_deliverable, is_safe_to_send, etc.).",
        "verb": "GET",
        "path": "/get-result-bulk-verification-task/",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "task_id"
          ],
          "properties": {
            "task_id": {
              "type": "string",
              "description": "Task ID returned by createBulkTask"
            }
          }
        },
        "category": "Verify email"
      },
      {
        "id": "accountBalance",
        "label": "Check Account Balance",
        "description": "Get remaining verification credits. Returns { api_status, remaining_daily_credits, remaining_instant_credits, status }. Daily credits reset each day; instant credits are purchased and do not reset.",
        "verb": "GET",
        "path": "/check-account-balance/",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      }
    ]
  },
  {
    "id": "smartlead",
    "name": "Smartlead",
    "version": "1.0.0",
    "category": "outreach",
    "description": "Cold email at scale — manage campaigns, push leads, read stats.",
    "baseUrl": "https://server.smartlead.ai/api/v1",
    "logo": "https://www.google.com/s2/favicons?domain=smartlead.ai&sz=128",
    "auth": {
      "type": "apiKey",
      "query": "api_key",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 60,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "listCampaigns",
        "label": "List Campaigns",
        "description": "List all campaigns. Returns an array of campaign objects.",
        "verb": "GET",
        "path": "/campaigns/",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "include_tags": {
              "type": "boolean",
              "description": "Include campaign tags"
            }
          }
        }
      },
      {
        "id": "getCampaign",
        "label": "Get Campaign",
        "description": "Get a single campaign by id.",
        "verb": "GET",
        "path": "/campaigns/{campaign_id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "campaign_id"
          ],
          "properties": {
            "campaign_id": {
              "type": "integer",
              "description": "Smartlead campaign id"
            }
          }
        },
        "options": {
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "addLeadsToCampaign",
        "label": "Add Leads to Campaign",
        "description": "Add contacts to a campaign (max 400). `lead_list` is an array of leads; only `email` is required per lead. Returns { added_count, skipped_count, skipped_leads }.",
        "verb": "POST",
        "path": "/campaigns/{campaign_id}/leads",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "campaign_id",
            "lead_list"
          ],
          "properties": {
            "campaign_id": {
              "type": "integer",
              "description": "Target campaign id"
            },
            "lead_list": {
              "type": "array",
              "description": "Up to 400 leads",
              "items": {
                "type": "object",
                "required": [
                  "email"
                ],
                "properties": {
                  "email": {
                    "type": "string"
                  },
                  "first_name": {
                    "type": "string"
                  },
                  "last_name": {
                    "type": "string"
                  },
                  "company_name": {
                    "type": "string"
                  },
                  "phone_number": {
                    "type": "string"
                  },
                  "website": {
                    "type": "string"
                  },
                  "location": {
                    "type": "string"
                  },
                  "linkedin_profile": {
                    "type": "string"
                  },
                  "custom_fields": {
                    "type": "object"
                  }
                }
              }
            },
            "settings": {
              "type": "object",
              "description": "Optional import settings (ignore_global_block_list, ignore_unsubscribe_list, ignore_duplicate_leads_in_other_campaign, etc.)"
            }
          }
        },
        "options": {
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        },
        "rateLimit": {
          "rpm": 30
        }
      },
      {
        "id": "fetchLeadByEmail",
        "label": "Find Lead by Email",
        "description": "Fetch a lead by email address. Returns the lead object, or {} if not found.",
        "verb": "GET",
        "path": "/leads/",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "campaignStatistics",
        "label": "Get Campaign Statistics",
        "description": "Per-lead/sequence activity for a campaign (sent, opened, clicked, replied, bounced).",
        "verb": "GET",
        "path": "/campaigns/{campaign_id}/statistics",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "campaign_id"
          ],
          "properties": {
            "campaign_id": {
              "type": "integer"
            },
            "offset": {
              "type": "integer"
            },
            "limit": {
              "type": "integer",
              "description": "Max 1000"
            }
          }
        },
        "options": {
          "campaign_id": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "listEmailAccounts",
        "label": "List Email Accounts",
        "description": "List all connected sending email accounts (senders).",
        "verb": "GET",
        "path": "/email-accounts/",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "offset": {
              "type": "integer"
            },
            "limit": {
              "type": "integer"
            }
          }
        }
      }
    ]
  },
  {
    "id": "smuggler",
    "name": "Smuggler",
    "version": "1.0.0",
    "category": "social-intelligence",
    "description": "LinkedIn outbound + engagement intelligence — search people/companies, find emails, and pull post engagers.",
    "baseUrl": "https://smuggler.dev/api/v1",
    "logo": "https://www.google.com/s2/favicons?domain=smuggler.dev&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "x-api-key",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 120,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "searchPersons",
        "label": "Search People",
        "description": "Search Smuggler's people by free-text query, company, title, or location. Returns data[] of { id, fullName, headline, linkedinUrl, jobTitle, jobCompanyName, locationCountry, enrichmentStatus }. Use the returned id with findEmail.",
        "verb": "GET",
        "path": "/persons",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Free-text search (name/headline)"
            },
            "company": {
              "type": "string"
            },
            "title": {
              "type": "string"
            },
            "location": {
              "type": "string"
            },
            "limit": {
              "type": "integer",
              "description": "Max 100 (default 50)"
            },
            "offset": {
              "type": "integer"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "getPerson",
        "label": "Get Person",
        "description": "Get a single person by Smuggler id. Returns { id, fullName, headline, linkedinUrl, jobTitle, jobCompanyName, seniority, jobFunction, locationCountry, enrichmentStatus }.",
        "verb": "GET",
        "path": "/persons/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Smuggler person id"
            }
          }
        },
        "category": "Enrich people"
      },
      {
        "id": "findEmail",
        "label": "Find Email",
        "description": "Find a person's email by Smuggler person id (synchronous waterfall via LeadMagic). Consumes credits. No request body needed — the id is in the path.",
        "verb": "POST",
        "path": "/persons/{id}/email",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Smuggler person id"
            }
          }
        },
        "category": "Find email",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "bulkFindEmail",
        "label": "Bulk Find Email",
        "description": "Queue email enrichment for up to 500 people by id (background). Already-enriched ids are skipped.",
        "verb": "POST",
        "path": "/persons/email/bulk",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "personIds"
          ],
          "properties": {
            "personIds": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "1-500 person ids"
            }
          }
        },
        "category": "Find email",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "searchCompanies",
        "label": "Search Companies",
        "description": "Search companies by name. Returns data[] of { id, name, logoUrl, employeeCountRange, industry }.",
        "verb": "GET",
        "path": "/companies",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Company name"
            },
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "offset": {
              "type": "integer"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "getCompany",
        "label": "Get Company",
        "description": "Get a single company by Smuggler id.",
        "verb": "GET",
        "path": "/companies/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "listCampaigns",
        "label": "List Campaigns",
        "description": "List engagement-monitoring campaigns. Returns data[] of { id, name, status, profileCount, leadCount }. Use a campaign id to filter listLeads.",
        "verb": "GET",
        "path": "/campaigns",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "offset": {
              "type": "integer"
            },
            "search": {
              "type": "string",
              "description": "Filter by campaign name"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "listProfiles",
        "label": "List Monitored Profiles",
        "description": "List LinkedIn profiles being monitored for engagement. Returns data[] of { id, fullName, headline, linkedinUrl, status, lastSyncedAt }. Use a profile id with topEngagers or to filter listLeads.",
        "verb": "GET",
        "path": "/profiles",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "offset": {
              "type": "integer"
            },
            "campaignId": {
              "type": "string",
              "description": "Filter by campaign"
            },
            "search": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "listPosts",
        "label": "List Monitored Posts",
        "description": "List LinkedIn posts being tracked for engagement. Returns data[] of { id, title, authorName, postUrl, engagementCount, postedAt }. Use a post id with postEngagements.",
        "verb": "GET",
        "path": "/posts",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "offset": {
              "type": "integer"
            },
            "profileId": {
              "type": "string",
              "description": "Filter by monitored profile"
            },
            "search": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "listLeads",
        "label": "List Leads",
        "description": "List captured leads (people who engaged with monitored profiles/posts) with engagement counts and enrichment status. Filter by campaignId, profileId, or search.",
        "verb": "GET",
        "path": "/leads",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Max 100"
            },
            "offset": {
              "type": "integer"
            },
            "campaignId": {
              "type": "string"
            },
            "profileId": {
              "type": "string"
            },
            "search": {
              "type": "string"
            }
          }
        },
        "category": "Signals",
        "options": {
          "campaignId": {
            "method": "listCampaigns",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          },
          "profileId": {
            "method": "listProfiles",
            "labelKey": "fullName",
            "valueKey": "id",
            "sublabelKey": "headline",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "postEngagements",
        "label": "Get Post Engagements",
        "description": "Get the people who engaged with a LinkedIn post (by Smuggler post id). Returns data[] of { id, type, engagerName, engagerHeadline, engagerLinkedinUrl, engagedAt }.",
        "verb": "GET",
        "path": "/posts/{id}/engagements",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Smuggler post id"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listPosts",
            "labelKey": "title",
            "valueKey": "id",
            "sublabelKey": "authorName",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "topEngagers",
        "label": "Get Top Engagers",
        "description": "Get the top engagers for a monitored profile (by Smuggler profile id). Returns data[] of { personId, fullName, headline, engagementCount, lastEngagedAt }.",
        "verb": "GET",
        "path": "/profiles/{id}/top-engagers",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Smuggler profile id"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listProfiles",
            "labelKey": "fullName",
            "valueKey": "id",
            "sublabelKey": "headline",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "credits",
        "label": "Get Credit Balance",
        "description": "Get the account credit balance and usage. Returns { allowed, balance, usage, included, unlimited, interval, nextResetAt }.",
        "verb": "GET",
        "path": "/billing/credits",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      }
    ]
  },
  {
    "id": "supabase",
    "name": "Supabase",
    "version": "1.0.0",
    "category": "database",
    "description": "Query and manage your Supabase Postgres projects via the Management API.",
    "logo": "https://www.google.com/s2/favicons?domain=supabase.com&sz=128",
    "baseUrl": "https://api.supabase.com",
    "auth": {
      "type": "apiKey",
      "header": "Authorization",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 120,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "runQuery",
        "label": "Run SQL Query",
        "description": "★ Run arbitrary SQL against a project's Postgres database and get rows back — this is how you 'query databases' through the Management API (there is no PostgREST data API here). Body: { query (required, the SQL string — a single statement or a script), read_only?, parameters? }. Runs as the `postgres` role, so it CAN read AND mutate (INSERT/UPDATE/DELETE/DDL). Returns an array of result rows (e.g. [{ ... }]). Path needs the project `ref`. Write — 1 credit (can mutate).",
        "verb": "POST",
        "path": "/v1/projects/{ref}/database/query",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref",
            "query"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref (the 20-char id in the dashboard URL / from listProjects)"
            },
            "query": {
              "type": "string",
              "description": "The SQL to run, e.g. \"SELECT * FROM users WHERE email = 'a@b.com' LIMIT 50\". Single string."
            },
            "read_only": {
              "type": "boolean",
              "description": "Run in a read-only transaction so writes are rejected (safer for SELECTs)"
            },
            "parameters": {
              "type": "array",
              "items": {},
              "description": "Optional positional bind parameters for the query"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "runQueryReadOnly",
        "label": "Run SQL Query (Read-Only)",
        "description": "Run SQL in a guaranteed read-only transaction — any write/DDL is rejected by Postgres. Safe way to SELECT / inspect schema. Body: { query (required), parameters? }. Returns an array of result rows. Path needs `ref`. Free read.",
        "verb": "POST",
        "path": "/v1/projects/{ref}/database/query/read-only",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref",
            "query"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "query": {
              "type": "string",
              "description": "Read-only SQL, e.g. a SELECT or an information_schema lookup"
            },
            "parameters": {
              "type": "array",
              "items": {},
              "description": "Optional positional bind parameters"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getDatabaseContext",
        "label": "Get Database Context",
        "description": "Get a compact description of the database — schemas, tables, columns and extensions — useful before writing SQL so you know what exists. Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/database/context",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "rateLimit": {
          "rpm": 10,
          "rps": 1
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "listMigrations",
        "label": "List Migrations",
        "description": "List the migration history for a project's database. Returns [{ version, name }]. Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/database/migrations",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "applyMigration",
        "label": "Apply Migration",
        "description": "Apply a new migration to the database (records it in the migration history). Body: { query (required, the migration SQL), name?, rollback? }. Path needs `ref`. Write — 1 credit.",
        "verb": "POST",
        "path": "/v1/projects/{ref}/database/migrations",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref",
            "query"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "query": {
              "type": "string",
              "description": "The migration SQL to apply"
            },
            "name": {
              "type": "string",
              "description": "Human-readable migration name"
            },
            "rollback": {
              "type": "string",
              "description": "Optional rollback SQL"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "upsertMigration",
        "label": "Upsert Migration",
        "description": "Create or update (idempotently apply) a migration. Body: { query (required), name?, rollback? }. Path needs `ref`. Write — 1 credit.",
        "verb": "PUT",
        "path": "/v1/projects/{ref}/database/migrations",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref",
            "query"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "query": {
              "type": "string",
              "description": "The migration SQL"
            },
            "name": {
              "type": "string",
              "description": "Migration name"
            },
            "rollback": {
              "type": "string",
              "description": "Optional rollback SQL"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "enableWebhooks",
        "label": "Enable Database Webhooks",
        "description": "Enable Database Webhooks (pg_net / supabase_functions triggers) for the project. No body. Path needs `ref`. Write — 1 credit.",
        "verb": "POST",
        "path": "/v1/projects/{ref}/database/webhooks/enable",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getTypescriptTypes",
        "label": "Generate TypeScript Types",
        "description": "Generate TypeScript type definitions for the project's database schema. Query: included_schemas? (comma-separated, e.g. 'public,auth'). Returns { types } (a TS string). Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/types/typescript",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "included_schemas": {
              "type": "string",
              "description": "Comma-separated schemas to include, e.g. 'public,auth' (default 'public')"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getPgbouncerConfig",
        "label": "Get PgBouncer Config",
        "description": "Get the project's PgBouncer connection-pooler configuration. Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/config/database/pgbouncer",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getPoolerConfig",
        "label": "Get Supavisor Pooler Config",
        "description": "Get the project's Supavisor connection-pooler config (pool mode, sizes, connection string). Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/config/database/pooler",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getPostgresConfig",
        "label": "Get Postgres Config",
        "description": "Get the Postgres server configuration (e.g. max_connections, statement_timeout) for the project. Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/config/database/postgres",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "listProjects",
        "label": "List Projects",
        "description": "List all projects you can access. Returns [{ id (the ref), organization_id, name, region, created_at, status, database{ host, version } }]. Start here to find a project `ref` for the database/query endpoints. Free read.",
        "verb": "GET",
        "path": "/v1/projects",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "getProject",
        "label": "Get Project",
        "description": "Get one project by ref. Returns { id, name, organization_id, region, status, database{ host, version } }. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "createProject",
        "label": "Create Project",
        "description": "Provision a new Supabase project. Body: { name (required), organization_slug (required), db_pass (required, the Postgres password), region?, plan?, desired_instance_size?, template_url? }. Returns the created project incl. its `ref`. Write — 1 credit.",
        "verb": "POST",
        "path": "/v1/projects",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "organization_slug",
            "db_pass"
          ],
          "properties": {
            "name": {
              "type": "string",
              "description": "Project name"
            },
            "organization_slug": {
              "type": "string",
              "description": "Slug of the org to create it in (see listOrganizations)"
            },
            "db_pass": {
              "type": "string",
              "description": "Password for the project's Postgres database"
            },
            "region": {
              "type": "string",
              "description": "Region, e.g. 'us-east-1' (see availableRegions)"
            },
            "plan": {
              "type": "string",
              "description": "Billing plan, e.g. 'free' | 'pro'"
            },
            "desired_instance_size": {
              "type": "string",
              "description": "Compute size, e.g. 'micro','small','medium'"
            },
            "template_url": {
              "type": "string",
              "description": "Optional template repo URL to seed the project"
            }
          }
        },
        "options": {
          "organization_slug": {
            "method": "listOrganizations",
            "labelKey": "name",
            "valueKey": "slug"
          }
        }
      },
      {
        "id": "deleteProject",
        "label": "Delete Project",
        "description": "Permanently delete a project by ref. Destructive. Returns the deleted project. Write — 1 credit.",
        "verb": "DELETE",
        "path": "/v1/projects/{ref}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "pauseProject",
        "label": "Pause Project",
        "description": "Pause a project (stops its database). No body. Path needs `ref`. Write — 1 credit.",
        "verb": "POST",
        "path": "/v1/projects/{ref}/pause",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "restoreProject",
        "label": "Restore Project",
        "description": "Restore (unpause) a paused project. No body. Path needs `ref`. Write — 1 credit.",
        "verb": "POST",
        "path": "/v1/projects/{ref}/restore",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getProjectHealth",
        "label": "Get Project Health",
        "description": "Get the health of a project's services (db, auth, rest, realtime, storage). Query: services? (comma-separated). Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/health",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "services": {
              "type": "string",
              "description": "Comma-separated services to check, e.g. 'db,auth,rest,realtime,storage'"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "listApiKeys",
        "label": "List API Keys",
        "description": "List the project's API keys (anon, service_role and publishable/secret keys). Query: reveal? (true to return the actual key values). Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/api-keys",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "reveal": {
              "type": "boolean",
              "description": "Reveal the actual key values (default false)"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "createApiKey",
        "label": "Create API Key",
        "description": "Create a new project API key. Body: { type (required, e.g. 'publishable' | 'secret'), name (required), description?, secret_jwt_template? }. Path needs `ref`. Write — 1 credit.",
        "verb": "POST",
        "path": "/v1/projects/{ref}/api-keys",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref",
            "type",
            "name"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "type": {
              "type": "string",
              "description": "Key type, e.g. 'publishable' | 'secret'"
            },
            "name": {
              "type": "string",
              "description": "Key name"
            },
            "description": {
              "type": "string",
              "description": "Optional description"
            },
            "secret_jwt_template": {
              "type": "object",
              "description": "Optional JWT template config for the key"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getPostgrestConfig",
        "label": "Get PostgREST Config",
        "description": "Get the project's PostgREST (data API) configuration — exposed schemas, max rows, db extra search path. Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/postgrest",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getAuthConfig",
        "label": "Get Auth Config",
        "description": "Get the project's Auth (GoTrue) configuration — providers, JWT expiry, email/SMS settings. Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/config/auth",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getStorageConfig",
        "label": "Get Storage Config",
        "description": "Get the project's Storage configuration (file size limit, features). Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/config/storage",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "availableRegions",
        "label": "List Available Regions",
        "description": "List the regions you can provision new projects in (use a value here for createProject's `region`). Free read.",
        "verb": "GET",
        "path": "/v1/projects/available-regions",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "listOrganizations",
        "label": "List Organizations",
        "description": "List organizations you belong to. Returns [{ id, slug, name }]. Use the `slug` for createProject and member/project lookups. Free read.",
        "verb": "GET",
        "path": "/v1/organizations",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "getOrganization",
        "label": "Get Organization",
        "description": "Get one organization by slug. Returns { id, slug, name, ... }. Free read.",
        "verb": "GET",
        "path": "/v1/organizations/{slug}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "slug"
          ],
          "properties": {
            "slug": {
              "type": "string",
              "description": "Organization slug (from listOrganizations)"
            }
          }
        },
        "options": {
          "slug": {
            "method": "listOrganizations",
            "labelKey": "name",
            "valueKey": "slug"
          }
        }
      },
      {
        "id": "listOrganizationMembers",
        "label": "List Organization Members",
        "description": "List the members of an organization. Returns [{ user_id, email, role_name }]. Free read.",
        "verb": "GET",
        "path": "/v1/organizations/{slug}/members",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "slug"
          ],
          "properties": {
            "slug": {
              "type": "string",
              "description": "Organization slug"
            }
          }
        },
        "options": {
          "slug": {
            "method": "listOrganizations",
            "labelKey": "name",
            "valueKey": "slug"
          }
        }
      },
      {
        "id": "listOrganizationProjects",
        "label": "List Organization Projects",
        "description": "List the projects belonging to a specific organization. Returns project objects (each has its `ref`). Free read.",
        "verb": "GET",
        "path": "/v1/organizations/{slug}/projects",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "slug"
          ],
          "properties": {
            "slug": {
              "type": "string",
              "description": "Organization slug"
            }
          }
        },
        "options": {
          "slug": {
            "method": "listOrganizations",
            "labelKey": "name",
            "valueKey": "slug"
          }
        }
      },
      {
        "id": "createOrganization",
        "label": "Create Organization",
        "description": "Create a new organization. Body: { name (required) }. Returns the created org incl. its `slug`. Write — 1 credit.",
        "verb": "POST",
        "path": "/v1/organizations",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string",
              "description": "Organization name"
            }
          }
        }
      },
      {
        "id": "listSecrets",
        "label": "List Secrets",
        "description": "List the project's environment secrets (names, not values). Returns [{ name, value (masked) }]. Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/secrets",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "createSecrets",
        "label": "Create / Update Secrets",
        "description": "Create or update project secrets (env vars available to Edge Functions). The JSON body is an ARRAY of { name, value } — pass it as the request body. Path needs `ref`. Returns 201. Write — 1 credit.",
        "verb": "POST",
        "path": "/v1/projects/{ref}/secrets",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "secrets": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "Array of { name, value } secrets (the API body is this array)"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "deleteSecrets",
        "label": "Delete Secrets",
        "description": "Delete project secrets by name. The JSON body is an ARRAY of secret name strings. Path needs `ref`. Returns 200. Write — 1 credit.",
        "verb": "DELETE",
        "path": "/v1/projects/{ref}/secrets",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "names": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Array of secret names to delete (the API body is this array)"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "listFunctions",
        "label": "List Edge Functions",
        "description": "List the project's Edge Functions. Returns [{ id, slug, name, status, version, verify_jwt, created_at }]. Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/functions",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getFunction",
        "label": "Get Edge Function",
        "description": "Get one Edge Function by its slug. Returns { id, slug, name, status, version, verify_jwt }. Path needs `ref` and `function_slug`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/functions/{function_slug}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref",
            "function_slug"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "function_slug": {
              "type": "string",
              "description": "The function's slug"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getFunctionBody",
        "label": "Get Edge Function Body",
        "description": "Download the source body of an Edge Function by slug. Path needs `ref` and `function_slug`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/functions/{function_slug}/body",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref",
            "function_slug"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "function_slug": {
              "type": "string",
              "description": "The function's slug"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "createFunction",
        "label": "Create Edge Function",
        "description": "Create an Edge Function. Body: { slug (required), name (required), body (required, the Deno/TS source), verify_jwt? }. Path needs `ref`. Write — 1 credit.",
        "verb": "POST",
        "path": "/v1/projects/{ref}/functions",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref",
            "slug",
            "name",
            "body"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "slug": {
              "type": "string",
              "description": "URL slug for the function"
            },
            "name": {
              "type": "string",
              "description": "Display name"
            },
            "body": {
              "type": "string",
              "description": "The function source code (TypeScript/Deno)"
            },
            "verify_jwt": {
              "type": "boolean",
              "description": "Require a valid JWT to invoke (default true)"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          },
          "slug": {
            "method": "listOrganizations",
            "labelKey": "name",
            "valueKey": "slug"
          }
        }
      },
      {
        "id": "updateFunction",
        "label": "Update Edge Function",
        "description": "Update an Edge Function by slug. Body: { name?, body?, verify_jwt? } — only included fields change. Path needs `ref` and `function_slug`. Write — 1 credit.",
        "verb": "PATCH",
        "path": "/v1/projects/{ref}/functions/{function_slug}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref",
            "function_slug"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "function_slug": {
              "type": "string",
              "description": "The function's slug"
            },
            "name": {
              "type": "string",
              "description": "New display name"
            },
            "body": {
              "type": "string",
              "description": "New source code"
            },
            "verify_jwt": {
              "type": "boolean",
              "description": "Require a valid JWT to invoke"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "deleteFunction",
        "label": "Delete Edge Function",
        "description": "Delete an Edge Function by slug. Path needs `ref` and `function_slug`. Returns 200. Write — 1 credit.",
        "verb": "DELETE",
        "path": "/v1/projects/{ref}/functions/{function_slug}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref",
            "function_slug"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            },
            "function_slug": {
              "type": "string",
              "description": "The function's slug"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "listBuckets",
        "label": "List Storage Buckets",
        "description": "List the project's Storage buckets. Returns [{ id, name, public, created_at }]. Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/storage/buckets",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "listBranches",
        "label": "List Database Branches",
        "description": "List the database branches (preview environments) of a project. Returns [{ id, name, project_ref, is_default, status, git_branch }]. Path needs `ref`. Free read.",
        "verb": "GET",
        "path": "/v1/projects/{ref}/branches",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ref"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Parent project ref"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "createBranch",
        "label": "Create Database Branch",
        "description": "Create a database branch (preview environment) off a project. Body: { branch_name (required), git_branch?, region?, persistent?, with_data? }. Path needs `ref`. Write — 1 credit.",
        "verb": "POST",
        "path": "/v1/projects/{ref}/branches",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "ref",
            "branch_name"
          ],
          "properties": {
            "ref": {
              "type": "string",
              "description": "Parent project ref"
            },
            "branch_name": {
              "type": "string",
              "description": "Name for the new branch"
            },
            "git_branch": {
              "type": "string",
              "description": "Git branch to link the preview to"
            },
            "region": {
              "type": "string",
              "description": "Region for the branch's database"
            },
            "persistent": {
              "type": "boolean",
              "description": "Keep the branch alive between deploys"
            },
            "with_data": {
              "type": "boolean",
              "description": "Clone data from the parent into the branch"
            }
          }
        },
        "options": {
          "ref": {
            "method": "listProjects",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getBranch",
        "label": "Get Database Branch",
        "description": "Get a database branch's config by its branch id or ref. Returns { ref, status, db_host, db_port, ... }. Free read.",
        "verb": "GET",
        "path": "/v1/branches/{branch_id_or_ref}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "branch_id_or_ref"
          ],
          "properties": {
            "branch_id_or_ref": {
              "type": "string",
              "description": "Branch ref or (deprecated) branch id"
            }
          }
        }
      },
      {
        "id": "deleteBranch",
        "label": "Delete Database Branch",
        "description": "Delete a database branch by its branch id or ref. Query: force?. Returns { message }. Write — 1 credit.",
        "verb": "DELETE",
        "path": "/v1/branches/{branch_id_or_ref}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "branch_id_or_ref"
          ],
          "properties": {
            "branch_id_or_ref": {
              "type": "string",
              "description": "Branch ref or (deprecated) branch id"
            },
            "force": {
              "type": "boolean",
              "description": "Force-delete even if the branch is busy"
            }
          }
        }
      },
      {
        "id": "listSnippets",
        "label": "List SQL Snippets",
        "description": "List saved SQL Editor snippets. Query: project_ref?, cursor?, limit?, sort_by?, sort_order?. Returns saved queries you can re-run via runQuery. Free read.",
        "verb": "GET",
        "path": "/v1/snippets",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "project_ref": {
              "type": "string",
              "description": "Filter snippets to a project ref"
            },
            "cursor": {
              "type": "string",
              "description": "Pagination cursor"
            },
            "limit": {
              "type": "string",
              "description": "Page size"
            }
          }
        }
      },
      {
        "id": "getSnippet",
        "label": "Get SQL Snippet",
        "description": "Get a single saved SQL snippet by id, including its SQL content (feed it into runQuery). Free read.",
        "verb": "GET",
        "path": "/v1/snippets/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Snippet id"
            }
          }
        }
      },
      {
        "id": "getProfile",
        "label": "Get Authenticated User",
        "description": "Get the profile of the user/owner of the Personal Access Token in use. Returns { id, primary_email, username }. Handy to confirm the PAT works. Free read.",
        "verb": "GET",
        "path": "/v1/profile",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      }
    ]
  },
  {
    "id": "thecompaniesapi",
    "name": "The Companies API",
    "version": "1.0.0",
    "category": "enrichment",
    "description": "Company enrichment and search by domain, name, or attributes.",
    "logo": "https://www.thecompaniesapi.com/images/favicons/apple-touch-icon.png",
    "baseUrl": "https://api.thecompaniesapi.com/v2",
    "auth": {
      "type": "apiKey",
      "header": "Authorization",
      "scheme": "Basic ",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rps": 50,
      "concurrency": 5
    },
    "methods": [
      {
        "id": "enrichByDomain",
        "label": "Enrich Company by Domain",
        "description": "Enrich a company from its domain (e.g. 'stripe.com'). Returns ~80 nested datapoints: about.name, about.industry, about.totalEmployees, domain.domain, locations.headquarters, socials, technologies.active, finances.revenue, descriptions.primary, assets.logoSquare, etc. 1 credit.",
        "verb": "GET",
        "path": "/companies/{domain}",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "domain"
          ],
          "properties": {
            "domain": {
              "type": "string",
              "description": "Company website domain, e.g. 'stripe.com' (no http://)"
            },
            "simplified": {
              "type": "boolean",
              "description": "Return a smaller payload (free, no extra credits)"
            },
            "refresh": {
              "type": "boolean",
              "description": "Force a real-time recrawl (+10 credits)"
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "enrichByEmail",
        "label": "Enrich Company by Email",
        "description": "Enrich a company from a work email address (e.g. 'jane@stripe.com') — extracts the domain and returns the full company object (same shape as enrichByDomain). Use when you have an email but not the domain. 1 credit.",
        "verb": "GET",
        "path": "/companies/by-email",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "email"
          ],
          "properties": {
            "email": {
              "type": "string",
              "description": "Work email address, e.g. 'jane@stripe.com'"
            },
            "simplified": {
              "type": "boolean",
              "description": "Smaller payload"
            },
            "refresh": {
              "type": "boolean",
              "description": "Force recrawl (+10 credits)"
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "searchByName",
        "label": "Find Company by Name",
        "description": "Look up a company by its name (e.g. 'Stripe'). Returns matching company object(s) — names aren't unique so multiple may return.",
        "verb": "GET",
        "path": "/companies/by-name",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string",
              "description": "Company name to search for"
            },
            "exactWordsMatch": {
              "type": "boolean",
              "description": "Require all words to match exactly"
            },
            "countries": {
              "type": "string",
              "description": "Comma-separated country codes to filter, e.g. 'us,gb'"
            },
            "size": {
              "type": "integer",
              "description": "Max results 1-25 (default 1)"
            },
            "page": {
              "type": "integer",
              "description": "Page number for pagination (default 1)"
            },
            "simplified": {
              "type": "boolean",
              "description": "Smaller payload"
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "enrichBySocial",
        "label": "Enrich Company by Social URL",
        "description": "Enrich a company from one of its social network profile URLs. Pass whichever you have (linkedin is most useful for GTM). Returns the full company object. 1 credit.",
        "verb": "GET",
        "path": "/companies/by-social",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "linkedin": {
              "type": "string",
              "description": "LinkedIn company URL"
            },
            "twitter": {
              "type": "string",
              "description": "Twitter/X profile URL"
            },
            "facebook": {
              "type": "string",
              "description": "Facebook page URL"
            },
            "github": {
              "type": "string",
              "description": "GitHub org URL"
            },
            "instagram": {
              "type": "string",
              "description": "Instagram URL"
            },
            "youtube": {
              "type": "string",
              "description": "YouTube channel URL"
            },
            "tiktok": {
              "type": "string",
              "description": "TikTok URL"
            },
            "pinterest": {
              "type": "string",
              "description": "Pinterest URL"
            },
            "wellfound": {
              "type": "string",
              "description": "Wellfound/AngelList URL"
            },
            "refresh": {
              "type": "boolean",
              "description": "Force recrawl (+10 credits)"
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "searchCompanies",
        "label": "Search Companies by Attributes",
        "description": "Search the full company database with structured boolean conditions (industry, size, location, technology, revenue, etc.). Pass `query` as a JSON-encoded array of condition objects. Returns { companies[], meta, query }. 1 credit per company returned. Use for building target lists, not single-company lookups.",
        "verb": "GET",
        "path": "/companies",
        "credits": 2,
        "input": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "JSON-stringified+encoded array of condition objects (the segmentation filter). Build via promptToSegmentation if you have natural language."
            },
            "search": {
              "type": "string",
              "description": "Free-text query on company name or domain"
            },
            "searchFields": {
              "type": "string",
              "description": "Which fields the `search` term applies to"
            },
            "size": {
              "type": "integer",
              "description": "Results per page, 1-100 (default 10)"
            },
            "page": {
              "type": "integer",
              "description": "Page number (default 1)"
            },
            "sortKey": {
              "type": "string",
              "description": "Single field to sort by"
            },
            "sortOrder": {
              "type": "string",
              "description": "'asc' or 'desc'"
            },
            "domainsToExclude": {
              "type": "string",
              "description": "Comma-separated domains to exclude"
            },
            "linkedinToExclude": {
              "type": "string",
              "description": "Comma-separated LinkedIn URLs to exclude"
            },
            "simplified": {
              "type": "boolean",
              "description": "Return preview data without full credit deduction"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "searchByPrompt",
        "label": "Search Companies by Prompt",
        "description": "Search companies with a natural-language prompt (e.g. 'B2B SaaS companies in Germany with 50-200 employees using Salesforce'). The API converts it to a segmentation filter and returns matching { companies[], meta }. Easier than building a `query` array by hand. 1 credit per company returned.",
        "verb": "GET",
        "path": "/companies/by-prompt",
        "credits": 2,
        "input": {
          "type": "object",
          "required": [
            "prompt"
          ],
          "properties": {
            "prompt": {
              "type": "string",
              "description": "Natural-language description of the companies to find"
            },
            "similarity": {
              "type": "number",
              "description": "Minimum similarity threshold for matches"
            },
            "size": {
              "type": "integer",
              "description": "Results per page, 1-100 (default 10)"
            },
            "page": {
              "type": "integer",
              "description": "Page number (default 1)"
            },
            "listsToExclude": {
              "type": "string",
              "description": "Comma-separated list IDs whose companies to exclude"
            },
            "simplified": {
              "type": "boolean",
              "description": "Preview data without full credit deduction"
            }
          }
        },
        "category": "Search",
        "options": {
          "listsToExclude": {
            "method": "fetchLists",
            "itemsPath": "lists",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "size": 100
            }
          }
        }
      },
      {
        "id": "similarCompanies",
        "label": "Find Similar Companies",
        "description": "Given one or more seed domains, return companies similar to them (lookalike search). Pass `domains` comma-separated. Returns { companies[], meta }. 1 credit per company returned. Use to expand a target account list from known good-fit accounts.",
        "verb": "GET",
        "path": "/companies/similar",
        "credits": 2,
        "input": {
          "type": "object",
          "required": [
            "domains"
          ],
          "properties": {
            "domains": {
              "type": "string",
              "description": "Comma-separated seed domains, e.g. 'stripe.com,adyen.com'"
            },
            "size": {
              "type": "integer",
              "description": "Results per page, 1-100 (default 10)"
            },
            "page": {
              "type": "integer",
              "description": "Page number (default 1)"
            },
            "proximityExact": {
              "type": "number",
              "description": "Weight for exact-attribute proximity"
            },
            "proximityTerm": {
              "type": "number",
              "description": "Weight for semantic/term proximity"
            },
            "simplified": {
              "type": "boolean",
              "description": "Preview data without full credit deduction"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "countCompanies",
        "label": "Count Companies Matching a Filter",
        "description": "Return the total count of companies matching a segmentation `query` (and/or `search`) WITHOUT returning records — use to size a market/segment before paying to fetch. Returns { count }. Cheap (does not bill per-company).",
        "verb": "GET",
        "path": "/companies/count",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "JSON-stringified+encoded array of condition objects"
            },
            "search": {
              "type": "string",
              "description": "Free-text query on name/domain"
            },
            "searchFields": {
              "type": "string",
              "description": "Which fields the `search` term applies to"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "askCompany",
        "label": "Ask a Question About a Company",
        "description": "Ask a free-text question about a company (by domain) and get a structured AI answer (e.g. 'Does this company sell to enterprise?'). Define the output shape via `fields`. Returns { answer, meta }. Great for custom enrichment columns the standard datapoints don't cover. 1 credit.",
        "verb": "POST",
        "path": "/companies/{domain}/ask",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "domain",
            "question"
          ],
          "properties": {
            "domain": {
              "type": "string",
              "description": "Company website domain, e.g. 'stripe.com'"
            },
            "question": {
              "type": "string",
              "description": "The question to answer about the company"
            },
            "fields": {
              "type": "array",
              "description": "Array of { key, type, description } objects defining the structured answer shape",
              "items": {
                "type": "object"
              }
            },
            "model": {
              "type": "string",
              "description": "'large' (more detail) or 'small' (cheaper/faster)"
            },
            "explain": {
              "type": "boolean",
              "description": "Include reasoning behind the answer"
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "companyContext",
        "label": "Fetch Company Context",
        "description": "Get the full text context (crawled site content + profile) for a company by domain — the raw material the AI uses. Returns a large context blob. Useful to feed your own LLM column. 1 credit.",
        "verb": "GET",
        "path": "/companies/{domain}/context",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "domain"
          ],
          "properties": {
            "domain": {
              "type": "string",
              "description": "Company website domain, e.g. 'stripe.com'"
            }
          }
        },
        "category": "Enrich company"
      },
      {
        "id": "emailPatterns",
        "label": "Get Company Email Patterns",
        "description": "Get the email-format patterns a company uses (e.g. {first}.{last}@domain.com) with usage percentages. Returns the pattern, not specific people's emails. 1 credit.",
        "verb": "GET",
        "path": "/companies/{domain}/email-patterns",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "domain"
          ],
          "properties": {
            "domain": {
              "type": "string",
              "description": "Company website domain, e.g. 'stripe.com'"
            },
            "emailsCount": {
              "type": "integer",
              "description": "Number of example emails to base patterns on"
            },
            "precision": {
              "type": "string",
              "description": "Pattern precision level"
            }
          }
        },
        "category": "Find email"
      },
      {
        "id": "searchIndustries",
        "label": "Search Industries",
        "description": "Search the industry taxonomy by keyword. Returns { industries[] } with the canonical industry identifiers used in segmentation `query` filters. Use to resolve a human industry name to a valid filter value. Free/cheap.",
        "verb": "GET",
        "path": "/industries",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "search": {
              "type": "string",
              "description": "Industry keyword to search"
            },
            "size": {
              "type": "integer",
              "description": "Results per page"
            },
            "page": {
              "type": "integer",
              "description": "Page number"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "searchTechnologies",
        "label": "Search Technologies",
        "description": "Search the technology taxonomy by keyword (e.g. 'salesforce', 'react'). Returns { technologies[] } with canonical identifiers used in segmentation `query` filters (technographic targeting). Free/cheap.",
        "verb": "GET",
        "path": "/technologies",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "search": {
              "type": "string",
              "description": "Technology keyword to search"
            },
            "size": {
              "type": "integer",
              "description": "Results per page"
            },
            "page": {
              "type": "integer",
              "description": "Page number"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "searchCountries",
        "label": "Search Countries",
        "description": "Search/resolve countries for use in location segmentation filters. Returns { countries[] } with canonical codes. Free/cheap. (Sister endpoints exist for cities/states/counties/continents.)",
        "verb": "GET",
        "path": "/locations/countries",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "search": {
              "type": "string",
              "description": "Country name to search"
            },
            "filters": {
              "type": "string",
              "description": "Additional filter conditions"
            },
            "size": {
              "type": "integer",
              "description": "Results per page"
            },
            "page": {
              "type": "integer",
              "description": "Page number"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "searchCities",
        "label": "Search Cities",
        "description": "Search/resolve cities for use in location segmentation filters. Returns { cities[] } with canonical identifiers. Free/cheap.",
        "verb": "GET",
        "path": "/locations/cities",
        "credits": 1,
        "input": {
          "type": "object",
          "properties": {
            "search": {
              "type": "string",
              "description": "City name to search"
            },
            "filters": {
              "type": "string",
              "description": "Additional filter conditions (e.g. restrict to a country)"
            },
            "size": {
              "type": "integer",
              "description": "Results per page"
            },
            "page": {
              "type": "integer",
              "description": "Page number"
            }
          }
        },
        "category": "Search"
      },
      {
        "id": "enrichJobTitles",
        "label": "Enrich a Job Title",
        "description": "Normalize/classify a raw job title (e.g. 'VP Sales EMEA') into seniority, department, and canonical role. Returns the structured job-title enrichment. 1 credit.",
        "verb": "GET",
        "path": "/job-titles/enrich",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string",
              "description": "Raw job title to enrich, e.g. 'VP of Sales'"
            }
          }
        },
        "category": "Formatting"
      },
      {
        "id": "promptToSegmentation",
        "label": "Convert Prompt to Segmentation Filter",
        "description": "Turn a natural-language description into the structured segmentation `query` array used by searchCompanies / countCompanies. Returns the filter object. Use this first when you only have a prose ICP, then feed the result into searchCompanies. 1 credit.",
        "verb": "POST",
        "path": "/prompts/segmentation",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "prompt"
          ],
          "properties": {
            "prompt": {
              "type": "string",
              "description": "Natural-language ICP / target description"
            },
            "context": {
              "type": "string",
              "description": "Extra context to guide the conversion"
            },
            "model": {
              "type": "string",
              "description": "Model to use ('large' or 'small')"
            },
            "listId": {
              "type": "string",
              "description": "Optional list to scope against"
            },
            "force": {
              "type": "boolean",
              "description": "Force regeneration instead of using a cached result"
            }
          }
        },
        "category": "Search",
        "options": {
          "listId": {
            "method": "fetchLists",
            "itemsPath": "lists",
            "labelKey": "name",
            "valueKey": "id",
            "args": {
              "size": 100
            }
          }
        }
      },
      {
        "id": "checkUser",
        "label": "Fetch Account / Credits",
        "description": "Get the current API account info including remaining credit balance. Returns the user object. Free.",
        "verb": "GET",
        "path": "/user",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "fetchLists",
        "label": "List Company Lists",
        "description": "Fetch the team's saved company lists (paginated). Returns { lists[], meta } where each list has { id, name }. Backs the list-picker fields (listId, listsToExclude).",
        "verb": "GET",
        "path": "/lists",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "page": {
              "type": "integer",
              "description": "Page number (default 1)"
            },
            "size": {
              "type": "integer",
              "description": "Lists per page, 1-100 (default 10)"
            }
          }
        },
        "category": "Search"
      }
    ]
  },
  {
    "id": "trigify",
    "name": "Trigify",
    "version": "2.0.0",
    "category": "social",
    "description": "Social listening + engagement intelligence — monitor profiles, companies, posts and topics across LinkedIn, X/Twitter, Reddit, YouTube, Substack, Bluesky, GitHub, Hacker News, Daily.dev, Podcasts and News.",
    "baseUrl": "https://api.trigify.io",
    "logo": "https://www.google.com/s2/favicons?domain=trigify.io&sz=128",
    "auth": {
      "type": "apiKey",
      "header": "x-api-key",
      "secretKey": "apiKey"
    },
    "rateLimit": {
      "rpm": 100,
      "concurrency": 3
    },
    "methods": [
      {
        "id": "enrichProfile",
        "label": "Enrich LinkedIn Profile",
        "description": "Enrich a LinkedIn profile URL into name, title, company, summary, follower count, location, industry, and full work experience. Returns { data: { prospect, experience[] } }.",
        "verb": "POST",
        "path": "/v1/profile/enrich",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "profileUrl"
          ],
          "properties": {
            "profileUrl": {
              "type": "string",
              "description": "Full LinkedIn profile URL (e.g. https://linkedin.com/in/jane-doe)"
            }
          }
        },
        "category": "Enrich people",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "profilePosts",
        "label": "Get Profile Posts",
        "description": "List recent LinkedIn posts from a profile, with text, reactions, comments count, and media. Paginated.",
        "verb": "POST",
        "path": "/v1/profile/posts",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "profileUrl"
          ],
          "properties": {
            "profileUrl": {
              "type": "string",
              "description": "LinkedIn profile URL"
            },
            "page": {
              "type": "integer",
              "description": "0-based page number"
            },
            "after": {
              "type": "string",
              "description": "ISO date — only posts after this"
            },
            "paginationToken": {
              "type": "string",
              "description": "Cursor from previous response"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "profileEngagementBulk",
        "label": "Bulk Track Profiles (Engagement Monitor)",
        "description": "ENTERPRISE. Upload up to 100 LinkedIn profile URLs for engagement monitoring. Optionally attach a webhook per profile. Free upload; downstream collection costs 5 credits per new engagement result.",
        "verb": "POST",
        "path": "/v1/profile/engagement/bulk",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "profiles"
          ],
          "properties": {
            "profiles": {
              "type": "array",
              "description": "Array (1-100) of { profile_url, webhook_url? }",
              "items": {
                "type": "object"
              }
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "profileEngagementResults",
        "label": "Get Profile Engagement Results",
        "description": "ENTERPRISE. Paginated engagement results for a tracked LinkedIn profile, deduplicated by prospect across all their posts. Free.",
        "verb": "POST",
        "path": "/v1/profile/engagement/results",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "profile_url"
          ],
          "properties": {
            "profile_url": {
              "type": "string"
            },
            "page": {
              "type": "integer"
            },
            "page_size": {
              "type": "integer",
              "description": "1-100, default 10"
            }
          }
        },
        "category": "Signals",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "profilePostEngagementResults",
        "label": "Get Profile Post Engagement Results",
        "description": "ENTERPRISE. Engagement results for a SPECIFIC tracked post of a monitored profile. Deduplicated per prospect within that post.",
        "verb": "POST",
        "path": "/v1/profile/engagement/post-results",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "profile_url",
            "post_url"
          ],
          "properties": {
            "profile_url": {
              "type": "string"
            },
            "post_url": {
              "type": "string"
            },
            "page": {
              "type": "integer"
            },
            "page_size": {
              "type": "integer"
            }
          }
        },
        "category": "Signals",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "profileEngagementRemove",
        "label": "Stop Tracking Profile",
        "description": "ENTERPRISE. Archive a tracked LinkedIn profile and remove its webhook. Free.",
        "verb": "POST",
        "path": "/v1/profile/engagement/remove",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "profile_url"
          ],
          "properties": {
            "profile_url": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "enrichCompany",
        "label": "Enrich LinkedIn Company",
        "description": "Enrich a LinkedIn company URL into name, domain, industry, size, location, employees count, revenue, funding, technologies, growth rate.",
        "verb": "POST",
        "path": "/v1/company/enrich",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "companyUrl"
          ],
          "properties": {
            "companyUrl": {
              "type": "string",
              "description": "LinkedIn company URL"
            }
          }
        },
        "category": "Enrich company",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "companyPosts",
        "label": "Get Company Posts",
        "description": "List recent posts from a LinkedIn company page with reactions, comments count and media.",
        "verb": "POST",
        "path": "/v1/company/posts",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "companyUrl"
          ],
          "properties": {
            "companyUrl": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "companyComments",
        "label": "Get Company Post Comments",
        "description": "Get comments on a LinkedIn company post (by URN), paginated. Returns { comments[], total, totalPage, currentPage }.",
        "verb": "POST",
        "path": "/v1/company/comments",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "postUrn"
          ],
          "properties": {
            "postUrn": {
              "type": "string",
              "description": "Company post URN, e.g. '7196224250288955393'"
            },
            "page": {
              "type": "integer"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "postEngagements",
        "label": "Get Post Engagements",
        "description": "Get the list of users who engaged (liked, etc.) with a LinkedIn post URL. Paginated.",
        "verb": "POST",
        "path": "/v1/post/engagements",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "postUrl"
          ],
          "properties": {
            "postUrl": {
              "type": "string"
            },
            "page": {
              "type": "integer"
            }
          }
        },
        "category": "Signals",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "postComments",
        "label": "Get Post Comments",
        "description": "Get comments on a LinkedIn post by URN. Paginated. Use postCommentReplies to fetch replies of a specific comment.",
        "verb": "POST",
        "path": "/v1/post/comments",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "postUrn"
          ],
          "properties": {
            "postUrn": {
              "type": "string"
            },
            "page": {
              "type": "integer"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "postCommentReplies",
        "label": "Get Post Comment Replies",
        "description": "Get replies to a specific LinkedIn comment. Pass postUrn + commentUrn (returned by postComments). previousCursor paginates further pages.",
        "verb": "POST",
        "path": "/v1/post/comments/replies",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "postUrn",
            "commentUrn"
          ],
          "properties": {
            "postUrn": {
              "type": "string"
            },
            "commentUrn": {
              "type": "string",
              "description": "Comment URN, e.g. 'urn:li:comment:(urn:li:ugcPost:...,...)'"
            },
            "previousCursor": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "postByUrl",
        "label": "Get Post by URL",
        "description": "Resolve a LinkedIn post URL into its full detail: text, URN, posted date, reaction counts, author, company.",
        "verb": "POST",
        "path": "/v1/post/by-url",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "postUrl"
          ],
          "properties": {
            "postUrl": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "socialMapping",
        "label": "Social Mapping (Engagement Graph)",
        "description": "ENTERPRISE. Query Trigify's social engagement graph by keyword, firmographic and profile filters. Find prospects who engaged with specific topics. engaged_with_days = lookback (1-30).",
        "verb": "POST",
        "path": "/v1/social/mapping",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "engaged_with_keywords",
            "engaged_with_days"
          ],
          "properties": {
            "engaged_with_keywords": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "engaged_with_days": {
              "type": "number",
              "description": "1-30"
            },
            "engaged_with_topic_strength": {
              "type": "number",
              "description": "0-5, engagement frequency strength"
            },
            "job_titles": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "job_titles_excludes": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "company_domain_includes": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "company_domain_excludes": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "location_country": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "location_excludes": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "industries": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "industries_excludes": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "company_sizes": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "1-10, 11-50, 51-200, 201-500, 501-1000, 1001-5000, 5001-10000, 10001+"
            },
            "followers": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "page": {
              "type": "integer"
            },
            "page_size": {
              "type": "integer",
              "description": "10, 25 or 50"
            },
            "includes": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Fields to return: first_name, last_name, linkedin_url, avatar, company, job_title, post.text, etc."
            }
          }
        },
        "category": "Signals",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "listSearches",
        "label": "List Searches",
        "description": "List all Social Listening searches for the authenticated org. Filter by status. Free.",
        "verb": "GET",
        "path": "/v1/searches",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "status": {
              "type": "string",
              "description": "active | paused"
            },
            "limit": {
              "type": "integer",
              "description": "default 50, max 100"
            },
            "cursor": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "getSearch",
        "label": "Get Search",
        "description": "Get details of one Social Listening search by ID. Free.",
        "verb": "GET",
        "path": "/v1/searches/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Search ID"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listSearches",
            "itemsPath": "data",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "updateSearch",
        "label": "Update Search",
        "description": "Update a Social Listening search's name, status (active/paused), or filters. Free.",
        "verb": "PATCH",
        "path": "/v1/searches/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "status": {
              "type": "string",
              "description": "active | paused"
            },
            "filters": {
              "type": "object"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listSearches",
            "itemsPath": "data",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "deleteSearch",
        "label": "Delete Search",
        "description": "Permanently delete a Social Listening search. Free.",
        "verb": "DELETE",
        "path": "/v1/searches/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listSearches",
            "itemsPath": "data",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "searchResults",
        "label": "Get Search Results",
        "description": "Fetch results from a saved Social Listening search. Filter by date, job title, company, industry, country, seniority. Free.",
        "verb": "GET",
        "path": "/v1/searches/{id}/results",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Search ID"
            },
            "from": {
              "type": "string",
              "description": "ISO 8601 date"
            },
            "limit": {
              "type": "integer",
              "description": "max 100"
            },
            "cursor": {
              "type": "string"
            },
            "job_title": {
              "type": "string"
            },
            "company": {
              "type": "string"
            },
            "industry": {
              "type": "string"
            },
            "country": {
              "type": "string"
            },
            "seniority": {
              "type": "string",
              "description": "director, vp, c_suite, etc."
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listSearches",
            "itemsPath": "data",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "searchPodcasts",
        "label": "Search Podcasts",
        "description": "Search for podcasts by name. Use the returned id as podcast_id when creating a podcast-episodes monitor. Free.",
        "verb": "POST",
        "path": "/v1/searches/podcasts/search",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "query"
          ],
          "properties": {
            "query": {
              "type": "string"
            },
            "limit": {
              "type": "number",
              "description": "default 5, max 20"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createTwitterPostsSearch",
        "label": "Create Twitter/X Posts Search",
        "description": "Monitor X/Twitter posts by keywords. Supports advanced operators: from_users, to_user, list_id, verified_only, has_media, exclude_retweets, place_country. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/twitter/posts",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "max 10"
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "time_frame": {
              "type": "string",
              "description": "past-24h | past-week | past-month | past-6-months | past-year | all-time"
            },
            "max_results": {
              "type": "number",
              "description": "10-100"
            },
            "frequency": {
              "type": "string",
              "description": "hourly | every-12h | daily | weekly | monthly | quarterly"
            },
            "search_type": {
              "type": "string",
              "description": "Top | Latest | Videos | Photos"
            },
            "twitter_language": {
              "type": "string"
            },
            "exclude_retweets": {
              "type": "boolean"
            },
            "exclude_replies": {
              "type": "boolean"
            },
            "verified_only": {
              "type": "boolean"
            },
            "has_media": {
              "type": "string",
              "description": "any | images | video"
            },
            "has_links": {
              "type": "boolean"
            },
            "from_users": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "to_user": {
              "type": "string"
            },
            "url_contains": {
              "type": "string"
            },
            "place_country": {
              "type": "string"
            },
            "retweets_of": {
              "type": "string"
            },
            "list_id": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createLinkedInPostsSearch",
        "label": "Create LinkedIn Posts Search",
        "description": "Monitor LinkedIn posts by keywords. Filter by job_titles (max 6), content_type, member/org mentions. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/linkedin/posts",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "keywords"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "1-6 keywords"
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            },
            "job_titles": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "max 6 job title filters"
            },
            "content_type": {
              "type": "string",
              "description": "videos | photos | liveVideos | collaborativeArticles | documents"
            },
            "linkedin_sort_by": {
              "type": "string",
              "description": "date_posted | relevance"
            },
            "mentions_member": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "mentions_organization": {
              "type": "array",
              "items": {
                "type": "integer"
              }
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createRedditPostsSearch",
        "label": "Create Reddit Posts Search",
        "description": "Monitor Reddit posts AND comments across all of Reddit by keywords. Use createSubredditPostsSearch to monitor a specific subreddit instead. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/reddit/posts",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "keywords"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "1-10 keywords"
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createSubredditPostsSearch",
        "label": "Create Subreddit Monitor",
        "description": "Monitor a SPECIFIC subreddit for new posts (no r/ prefix). Optionally filter by keywords. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/reddit/subreddit",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "subreddit"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "subreddit": {
              "type": "string",
              "description": "Without r/ prefix, e.g. 'machinelearning'"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createYouTubeVideosSearch",
        "label": "Create YouTube Videos Search",
        "description": "Monitor YouTube videos by keywords. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/youtube/videos",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "keywords"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "1-10 keywords"
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createSubstackPostsSearch",
        "label": "Create Substack Posts Search",
        "description": "Monitor Substack posts by keywords and/or a specific publication. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/substack/posts",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "max 10"
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "publication": {
              "type": "string",
              "description": "Publication name/subdomain/URL"
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createSubstackNotesSearch",
        "label": "Create Substack Notes Monitor",
        "description": "Monitor a specific Substack author's notes by handle (@username or username). Optionally filter by keywords. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/substack/notes",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "author_handle"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "author_handle": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createPodcastKeywordsSearch",
        "label": "Create Podcast Keywords Search",
        "description": "Monitor podcast episode TRANSCRIPTS for keywords. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/podcast/keywords",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "keywords"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "1-10 keywords"
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createHackerNewsStoriesSearch",
        "label": "Create Hacker News Stories Search",
        "description": "Monitor Hacker News stories and comments by keywords. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/hackernews/stories",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "keywords"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "1-6 keywords"
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createNewsApiAiPostsSearch",
        "label": "Create News Articles Monitor",
        "description": "Monitor news articles by keywords (boolean OR/AND/NOT). Optionally restrict to specific publisher domains or country. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/newsapi-ai/posts",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "keywords"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "1-10 keywords"
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            },
            "source_uris": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Publisher domains, e.g. ['bbc.com']"
            },
            "exclude_source_uris": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "source_location_uri": {
              "type": "string",
              "description": "Wikidata-style country URI"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createDailyDevPostsSearch",
        "label": "Create Daily.dev Posts Search",
        "description": "Monitor Daily.dev developer posts. Multiple search modes: keyword-search, tag-based-feed, source-based-feed, smart-recommendations, most-discussed, popular-by-tags. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/dailydev/posts",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "tags": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "tags_block": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "sources_follow": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "sources_block": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "search_mode": {
              "type": "string",
              "description": "keyword-search | smart-recommendations | tag-based-feed | source-based-feed | popular-by-tags | most-discussed"
            },
            "source_id": {
              "type": "string",
              "description": "Required for source-based-feed"
            },
            "order_by": {
              "type": "string",
              "description": "DATE | UPVOTES | DOWNVOTES | COMMENTS | CLICKS"
            },
            "min_upvotes": {
              "type": "integer"
            },
            "min_views": {
              "type": "integer"
            },
            "disable_engagement_filter": {
              "type": "boolean"
            },
            "blocked_words": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "blocked_content_types": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "discussed_period": {
              "type": "integer",
              "description": "Days, most-discussed mode only"
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createGitHubIssuesSearch",
        "label": "Create GitHub Issues Search",
        "description": "Monitor GitHub issues by keywords. Optionally scope to specific repos (owner/repo format). Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/github/issues",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "max 10"
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "github_repos": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "owner/repo format"
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createGitHubDiscussionsSearch",
        "label": "Create GitHub Discussions Search",
        "description": "Monitor GitHub discussions by keywords. Optionally scope to specific repos. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/github/discussions",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "github_repos": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createBlueskyPostsSearch",
        "label": "Create Bluesky Posts Search",
        "description": "Monitor Bluesky posts by keywords. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/bluesky/posts",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "keywords"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "1-10 keywords"
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createTwitterProfileSearch",
        "label": "Monitor Twitter/X Profile",
        "description": "Monitor new posts from a specific X/Twitter profile URL. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/twitter/profile",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "profile_url"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "profile_url": {
              "type": "string",
              "description": "https://x.com/username"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createLinkedInProfileSearch",
        "label": "Monitor LinkedIn Profile or Company",
        "description": "Monitor new posts from a specific LinkedIn profile OR company page. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/linkedin/profile",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "profile_url"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "profile_url": {
              "type": "string",
              "description": "LinkedIn /in/ or /company/ URL"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            },
            "time_frame": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createYouTubeChannelSearch",
        "label": "Monitor YouTube Channel",
        "description": "Monitor new videos from a YouTube channel URL. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/youtube/channel",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "profile_url"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "profile_url": {
              "type": "string",
              "description": "YouTube channel URL"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            },
            "time_frame": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createSubstackProfileSearch",
        "label": "Monitor Substack Publication",
        "description": "Monitor new posts from a Substack publication. Provide profile_url OR publication (name/subdomain/URL). Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/substack/profile",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "profile_url": {
              "type": "string"
            },
            "publication": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            },
            "time_frame": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createBlueskyProfileSearch",
        "label": "Monitor Bluesky Profile",
        "description": "Monitor new posts from a Bluesky profile URL. Optionally filter by keywords. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/bluesky/profile",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "profile_url"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "profile_url": {
              "type": "string",
              "description": "https://bsky.app/profile/..."
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createPodcastEpisodesSearch",
        "label": "Monitor Podcast Episodes",
        "description": "Monitor new episodes from a specific podcast. Use searchPodcasts first to find the podcast_id. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/searches/podcast/episodes",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "name",
            "podcast_id",
            "podcast_name"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "podcast_id": {
              "type": "string",
              "description": "Podscan podcast ID from searchPodcasts"
            },
            "podcast_name": {
              "type": "string"
            },
            "podcast_image_url": {
              "type": "string"
            },
            "podcast_description": {
              "type": "string"
            },
            "max_results": {
              "type": "number"
            },
            "frequency": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "socialSignalsMetadata",
        "label": "Social Signals Metadata",
        "description": "Get supported Social Signals definitions, default config, statuses, and billing metadata.",
        "verb": "GET",
        "path": "/v1/social-signals/metadata",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        },
        "category": "Signals"
      },
      {
        "id": "socialSignalsLimits",
        "label": "Social Signals Limits",
        "description": "Get tier-derived Social Signals limits and current usage for the authenticated org.",
        "verb": "GET",
        "path": "/v1/social-signals/limits",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        },
        "category": "Signals"
      },
      {
        "id": "socialSignalsStatus",
        "label": "Social Signals Status",
        "description": "Get aggregate Social Signals subscription and enrichment status.",
        "verb": "GET",
        "path": "/v1/social-signals/status",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        },
        "category": "Signals"
      },
      {
        "id": "createSocialSignalSubscriptions",
        "label": "Create Social Signals Subscriptions",
        "description": "Batch upsert LinkedIn profile or company URLs into Social Signals monitoring (max 100).",
        "verb": "POST",
        "path": "/v1/social-signals/subscriptions",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "subscriptions"
          ],
          "properties": {
            "subscriptions": {
              "type": "array",
              "items": {
                "type": "object"
              },
              "description": "Array of { linkedin_url, config? }"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "listSocialSignalSubscriptions",
        "label": "List Social Signals Subscriptions",
        "description": "List Social Signals subscriptions, optionally filtered by status.",
        "verb": "GET",
        "path": "/v1/social-signals/subscriptions",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "status": {
              "type": "string",
              "description": "ACTIVE | PAUSED | STOPPED"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "bulkStopSocialSignalSubscriptions",
        "label": "Bulk Stop Social Signals Subscriptions",
        "description": "Stop multiple Social Signals subscriptions (max 100 IDs) without deleting historical results.",
        "verb": "POST",
        "path": "/v1/social-signals/subscriptions/bulk-stop",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "ids"
          ],
          "properties": {
            "ids": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "getSocialSignalSubscription",
        "label": "Get Social Signals Subscription",
        "description": "Get one Social Signals subscription by ID.",
        "verb": "GET",
        "path": "/v1/social-signals/subscriptions/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listSocialSignalSubscriptions",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "updateSocialSignalSubscription",
        "label": "Update Social Signals Subscription",
        "description": "Update Social Signals signal config or pause/resume a subscription.",
        "verb": "PATCH",
        "path": "/v1/social-signals/subscriptions/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "config": {
              "type": "object"
            },
            "status": {
              "type": "string",
              "description": "ACTIVE | PAUSED"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listSocialSignalSubscriptions",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "stopSocialSignalSubscription",
        "label": "Stop Social Signals Subscription",
        "description": "Stop one Social Signals subscription without deleting historical results.",
        "verb": "DELETE",
        "path": "/v1/social-signals/subscriptions/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listSocialSignalSubscriptions",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "estimateSocialSignals",
        "label": "Estimate Social Signals Credits",
        "description": "Estimate daily Social Signals credit usage for a subscription config. Provide either target_count or target_urls.",
        "verb": "POST",
        "path": "/v1/social-signals/estimate",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "config"
          ],
          "properties": {
            "config": {
              "type": "object"
            },
            "target_count": {
              "type": "integer",
              "description": "1-1000"
            },
            "target_urls": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "listSocialSignalFeed",
        "label": "List Social Signals Feed",
        "description": "Activity feed of Social Signals events and generated insights. Filter by signal type, severity, target, date range.",
        "verb": "GET",
        "path": "/v1/social-signals/feed",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "page": {
              "type": "integer"
            },
            "page_size": {
              "type": "integer",
              "description": "max 100"
            },
            "content_type": {
              "type": "string",
              "description": "all | signals | insights"
            },
            "severity": {
              "type": "string",
              "description": "LOW | MEDIUM | HIGH"
            },
            "signal_type": {
              "type": "string"
            },
            "target_id": {
              "type": "string"
            },
            "target_url": {
              "type": "string"
            },
            "subscription_id": {
              "type": "string"
            },
            "signal_date_from": {
              "type": "string"
            },
            "signal_date_to": {
              "type": "string"
            },
            "min_signals_per_target": {
              "type": "integer",
              "description": "1-10"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "listSocialSignalTargets",
        "label": "List Social Signals Targets",
        "description": "List monitored Social Signals targets with their latest signal and enrichment status.",
        "verb": "GET",
        "path": "/v1/social-signals/targets",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "page": {
              "type": "integer"
            },
            "page_size": {
              "type": "integer",
              "description": "max 100"
            },
            "severity": {
              "type": "string"
            },
            "signal_type": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "getSocialSignalTargetProfile",
        "label": "Get Social Signals Target Profile",
        "description": "Get a monitored target's profile, enrichment status, and recent signal timeline.",
        "verb": "GET",
        "path": "/v1/social-signals/targets/{id}/profile",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Target ID"
            },
            "timeline_limit": {
              "type": "integer",
              "description": "1-100"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listSocialSignalTargets",
            "labelKey": "name",
            "valueKey": "id"
          }
        }
      },
      {
        "id": "listSocialSignalTargetInsights",
        "label": "List Social Signals Target Insights",
        "description": "Generated AI insights for a monitored target.",
        "verb": "GET",
        "path": "/v1/social-signals/targets/{id}/insights",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "limit": {
              "type": "integer",
              "description": "1-20"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listSocialSignalTargets",
            "labelKey": "name",
            "valueKey": "id"
          }
        }
      },
      {
        "id": "listSocialSignalTargetCheckRuns",
        "label": "List Social Signals Target Check Runs",
        "description": "Recent Social Signals check runs (provider calls) for a target.",
        "verb": "GET",
        "path": "/v1/social-signals/targets/{id}/check-runs",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "limit": {
              "type": "integer",
              "description": "1-50"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listSocialSignalTargets",
            "labelKey": "name",
            "valueKey": "id"
          }
        }
      },
      {
        "id": "listSocialSignalResults",
        "label": "List Social Signals Results",
        "description": "List produced Social Signals results with filters by target, signal type, severity, subscription, date.",
        "verb": "GET",
        "path": "/v1/social-signals/results",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "page": {
              "type": "integer"
            },
            "page_size": {
              "type": "integer"
            },
            "severity": {
              "type": "string"
            },
            "signal_type": {
              "type": "string"
            },
            "target_id": {
              "type": "string"
            },
            "target_url": {
              "type": "string"
            },
            "subscription_id": {
              "type": "string"
            },
            "signal_date_from": {
              "type": "string"
            },
            "signal_date_to": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "getSocialSignalResult",
        "label": "Get Social Signals Result",
        "description": "Get one produced Social Signals result by ID.",
        "verb": "GET",
        "path": "/v1/social-signals/results/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "createTopic",
        "label": "Create Topic Search",
        "description": "ENTERPRISE. Create a Social Topic search for LinkedIn keyword monitoring. Active topics rediscover daily at 06:00 UTC; engagements backfill at Day 1, 3, 5. Free to create; credits charged per discovered post/engagement. Auto-expires after 30 days.",
        "verb": "POST",
        "path": "/v1/topics",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "name",
            "keywords"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "keywords": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "At least 1"
            },
            "keywords_and": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "keywords_not": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "job_titles": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "time_frame": {
              "type": "string"
            },
            "max_results": {
              "type": "integer",
              "description": "1-500"
            },
            "content_type": {
              "type": "string",
              "description": "posts | videos | photos | liveVideos | collaborativeArticles | documents"
            },
            "sort_by": {
              "type": "string",
              "description": "date_posted | relevance"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "listTopics",
        "label": "List Topic Searches",
        "description": "List all enterprise-only Social Topic searches for the org. Free.",
        "verb": "GET",
        "path": "/v1/topics",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "page": {
              "type": "integer"
            },
            "page_size": {
              "type": "integer"
            }
          }
        },
        "category": "Signals"
      },
      {
        "id": "getTopic",
        "label": "Get Topic Search",
        "description": "Get details for a Social Topic search. Free.",
        "verb": "GET",
        "path": "/v1/topics/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listTopics",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "updateTopic",
        "label": "Update Topic Search",
        "description": "Update topic name or status (ACTIVE/PAUSED/STOPPED). Free.",
        "verb": "PATCH",
        "path": "/v1/topics/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "status": {
              "type": "string"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listTopics",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "deleteTopic",
        "label": "Delete Topic Search",
        "description": "Soft-delete a Social Topic search. Free.",
        "verb": "DELETE",
        "path": "/v1/topics/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listTopics",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getTopicCreditsSummary",
        "label": "Get Topic Credit Summary",
        "description": "Current billing-period credit allocation for a topic, split between new-post credits and engagement-backfill credits. Free.",
        "verb": "GET",
        "path": "/v1/topics/{id}/credits-summary",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listTopics",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        }
      },
      {
        "id": "getTopicEngagements",
        "label": "Get Topic Engagements (Deduplicated)",
        "description": "Paginated engagers for a topic, deduplicated by prospect. Each prospect appears once with their latest engagement. Free.",
        "verb": "GET",
        "path": "/v1/topics/{id}/engagements",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "page": {
              "type": "integer"
            },
            "page_size": {
              "type": "integer"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listTopics",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        },
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "getTopicPostEngagements",
        "label": "Get Topic Post Engagements",
        "description": "All engagers for a specific LinkedIn post within a topic, with NO dedup. Free.",
        "verb": "GET",
        "path": "/v1/topics/{id}/posts/{postId}/engagements",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id",
            "postId"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Topic ID"
            },
            "postId": {
              "type": "string",
              "description": "LinkedIn post ID"
            },
            "page": {
              "type": "integer"
            },
            "page_size": {
              "type": "integer"
            }
          }
        },
        "category": "Signals",
        "options": {
          "id": {
            "method": "listTopics",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status"
          }
        },
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "getUsage",
        "label": "Get Usage Summary",
        "description": "Usage metrics for the authenticated org: credits consumed (with breakdown by feature), active monitors, results collected. Free.",
        "verb": "GET",
        "path": "/v1/usage",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "from": {
              "type": "string",
              "description": "ISO 8601, defaults to start of billing month"
            },
            "to": {
              "type": "string",
              "description": "ISO 8601, defaults to now"
            }
          }
        }
      },
      {
        "id": "xPostComments",
        "label": "Get X Post Comments",
        "description": "Fetch comments/replies on an X (Twitter) post URL. Up to 1000 comments per call.",
        "verb": "POST",
        "path": "/v1/x-post/comments",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "postUrl"
          ],
          "properties": {
            "postUrl": {
              "type": "string",
              "description": "https://x.com/user/status/..."
            },
            "maxComments": {
              "type": "integer",
              "description": "default 50, max 1000"
            }
          }
        },
        "category": "Signals",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "xPostEngagements",
        "label": "Get X Post Engagements (Likes)",
        "description": "List users who LIKED a given X post. Requires a connected X account on the org. Costs 1 credit PER engagement returned.",
        "verb": "POST",
        "path": "/v1/x-post/engagements",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "postUrl"
          ],
          "properties": {
            "postUrl": {
              "type": "string"
            },
            "maxEngagements": {
              "type": "integer",
              "description": "default 50, max 1000"
            }
          }
        },
        "category": "Signals",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "enrichXUser",
        "label": "Enrich X User",
        "description": "Enrich an X/Twitter user by handle (without @): bio, verified, follower/following/tweet counts, location, profile image, website.",
        "verb": "POST",
        "path": "/v1/x-user/enrich",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "username"
          ],
          "properties": {
            "username": {
              "type": "string",
              "description": "X handle WITHOUT @"
            }
          }
        },
        "category": "Enrich people",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "lookupXUser",
        "label": "Lookup X User by Username",
        "description": "Look up an X user's user_id, name, bio, and counts. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/x/lookup-user",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "username"
          ],
          "properties": {
            "username": {
              "type": "string"
            }
          }
        },
        "category": "Enrich people",
        "rateLimit": {
          "rps": 2
        }
      },
      {
        "id": "xLikePost",
        "label": "Like X Post (Action)",
        "description": "Like an X post using a connected X account. Costs 1 credit. Provide tweet_id; optionally specify which X account_id.",
        "verb": "POST",
        "path": "/v1/x/like-post",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "tweet_id"
          ],
          "properties": {
            "tweet_id": {
              "type": "string"
            },
            "account_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "account_id": {
            "method": "listXAccounts",
            "labelKey": "username",
            "valueKey": "id"
          }
        },
        "rateLimit": {
          "rps": 1
        }
      },
      {
        "id": "xReply",
        "label": "Reply to X Post (Action)",
        "description": "Reply to an X post. text max 280 chars. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/x/reply",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "tweet_id",
            "text"
          ],
          "properties": {
            "tweet_id": {
              "type": "string"
            },
            "text": {
              "type": "string",
              "description": "max 280 chars"
            },
            "account_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "account_id": {
            "method": "listXAccounts",
            "labelKey": "username",
            "valueKey": "id"
          }
        },
        "rateLimit": {
          "rps": 1
        }
      },
      {
        "id": "xRepost",
        "label": "Repost X Post (Action)",
        "description": "Repost (retweet) an X post. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/x/repost",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "tweet_id"
          ],
          "properties": {
            "tweet_id": {
              "type": "string"
            },
            "account_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "account_id": {
            "method": "listXAccounts",
            "labelKey": "username",
            "valueKey": "id"
          }
        },
        "rateLimit": {
          "rps": 1
        }
      },
      {
        "id": "xDeletePost",
        "label": "Delete X Post (Action)",
        "description": "Delete an X post you own. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/x/delete-post",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "tweet_id"
          ],
          "properties": {
            "tweet_id": {
              "type": "string"
            },
            "account_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "account_id": {
            "method": "listXAccounts",
            "labelKey": "username",
            "valueKey": "id"
          }
        },
        "rateLimit": {
          "rps": 1
        }
      },
      {
        "id": "xCreatePost",
        "label": "Create X Post (Action)",
        "description": "Create a new X post. Optionally include a poll (2-4 options, 5-10080 min duration) or media_ids (max 4). Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/x/create-post",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "text"
          ],
          "properties": {
            "text": {
              "type": "string",
              "description": "max 280 chars"
            },
            "poll_options": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "2-4 options"
            },
            "poll_duration_minutes": {
              "type": "integer",
              "description": "5-10080"
            },
            "media_ids": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "max 4"
            },
            "account_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "account_id": {
            "method": "listXAccounts",
            "labelKey": "username",
            "valueKey": "id"
          }
        },
        "rateLimit": {
          "rps": 1
        }
      },
      {
        "id": "xFollow",
        "label": "Follow X User (Action)",
        "description": "Follow an X user by their user_id. Costs 1 credit.",
        "verb": "POST",
        "path": "/v1/x/follow",
        "credits": 1,
        "input": {
          "type": "object",
          "required": [
            "target_user_id"
          ],
          "properties": {
            "target_user_id": {
              "type": "string"
            },
            "account_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "account_id": {
            "method": "listXAccounts",
            "labelKey": "username",
            "valueKey": "id"
          }
        },
        "rateLimit": {
          "rps": 1
        }
      },
      {
        "id": "xSendDm",
        "label": "Send X Direct Message (Action)",
        "description": "Send a DM on X. REQUIRES X Pro tier. Costs 2 credits. text max 10000 chars.",
        "verb": "POST",
        "path": "/v1/x/send-dm",
        "credits": 2,
        "input": {
          "type": "object",
          "required": [
            "user_id",
            "text"
          ],
          "properties": {
            "user_id": {
              "type": "string"
            },
            "text": {
              "type": "string",
              "description": "max 10000 chars"
            },
            "account_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "account_id": {
            "method": "listXAccounts",
            "labelKey": "username",
            "valueKey": "id"
          }
        },
        "rateLimit": {
          "rps": 1
        }
      },
      {
        "id": "listXAccounts",
        "label": "List Connected X Accounts",
        "description": "List all X accounts connected to the authenticated organisation. Free.",
        "verb": "GET",
        "path": "/v1/x/accounts",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "getXConnect",
        "label": "Get X Account Connect URL",
        "description": "Get the URL to connect a new X account, plus the current connection status. Free.",
        "verb": "GET",
        "path": "/v1/x/connect",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "listOrganisations",
        "label": "List Organisations",
        "description": "List all organisations the authenticated user has access to (owned + member).",
        "verb": "GET",
        "path": "/v1/org/list",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "getOrganisation",
        "label": "Get Organisation",
        "description": "Get the authenticated user's organisation including name, plan, subscription status, member count. Free.",
        "verb": "GET",
        "path": "/v1/org",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "creditsBalance",
        "label": "Get Credit Balance",
        "description": "Current credit balance, subscription plan, and next reset date. Free.",
        "verb": "GET",
        "path": "/v1/credits/balance",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "creditsUsage",
        "label": "Get Credit Usage History",
        "description": "Individual credit consumption records for the last N days. Free.",
        "verb": "GET",
        "path": "/v1/credits/usage",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "days": {
              "type": "string",
              "description": "1-365, default 30"
            },
            "limit": {
              "type": "string",
              "description": "1-500, default 100"
            },
            "offset": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "creditsBreakdown",
        "label": "Get Credit Usage Breakdown",
        "description": "Credit usage aggregated by feature for the last N days. Free.",
        "verb": "GET",
        "path": "/v1/credits/breakdown",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "days": {
              "type": "string",
              "description": "1-365, default 30"
            }
          }
        }
      },
      {
        "id": "createWorkflowTable",
        "label": "Create Workflow Table",
        "description": "Create a new Workflow Table for storing agent memory. Free.",
        "verb": "POST",
        "path": "/v1/workflow-tables",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "description": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "listWorkflowTables",
        "label": "List Workflow Tables",
        "description": "List all workflow tables for the org. Free.",
        "verb": "GET",
        "path": "/v1/workflow-tables",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "createWorkflow",
        "label": "Create Workflow",
        "description": "Create a new workflow from a JSON definition. Optionally link to a saved search. Free.",
        "verb": "POST",
        "path": "/v1/workflows",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "name",
            "workflow"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "description": {
              "type": "string"
            },
            "workflow": {
              "type": "object",
              "description": "Workflow definition JSON"
            },
            "search_id": {
              "type": "string"
            },
            "enabled": {
              "type": "boolean"
            },
            "status": {
              "type": "string",
              "description": "DRAFT | PUBLISHED"
            }
          }
        },
        "options": {
          "search_id": {
            "method": "listSearches",
            "itemsPath": "data",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "listWorkflows",
        "label": "List Workflows",
        "description": "List workflows for the org, paginated. Free.",
        "verb": "GET",
        "path": "/v1/workflows",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "string"
            },
            "offset": {
              "type": "string"
            },
            "status": {
              "type": "string",
              "description": "DRAFT | PUBLISHED"
            }
          }
        }
      },
      {
        "id": "listWorkflowActions",
        "label": "List Workflow Actions",
        "description": "List all available workflow action kinds with inputs/outputs. Free. Useful for building workflow JSON.",
        "verb": "GET",
        "path": "/v1/workflows/actions",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "category": {
              "type": "string",
              "description": "ai | enrichment | crm | messaging | social | control_flow | utility | integration | other"
            }
          }
        }
      },
      {
        "id": "listWorkflowExamples",
        "label": "List Workflow Examples",
        "description": "Example workflow definitions for common patterns. Free.",
        "verb": "GET",
        "path": "/v1/workflows/examples",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "listWorkflowTriggers",
        "label": "List Workflow Triggers",
        "description": "Available workflow trigger kinds with inputs/outputs. Free.",
        "verb": "GET",
        "path": "/v1/workflows/triggers",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "getWorkflow",
        "label": "Get Workflow",
        "description": "Get a single workflow by ID. Free.",
        "verb": "GET",
        "path": "/v1/workflows/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "options": {
          "id": {
            "method": "listWorkflows",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "updateWorkflow",
        "label": "Update Workflow",
        "description": "Partially update a workflow. Free.",
        "verb": "PATCH",
        "path": "/v1/workflows/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "description": {
              "type": "string"
            },
            "workflow": {
              "type": "object"
            },
            "enabled": {
              "type": "boolean"
            },
            "status": {
              "type": "string",
              "description": "DRAFT | PUBLISHED"
            }
          }
        },
        "options": {
          "id": {
            "method": "listWorkflows",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "deleteWorkflow",
        "label": "Delete Workflow",
        "description": "Soft-delete a workflow. Free.",
        "verb": "DELETE",
        "path": "/v1/workflows/{id}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "options": {
          "id": {
            "method": "listWorkflows",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "upsertWorkflowDraft",
        "label": "Upsert Workflow Draft",
        "description": "Create or update the draft for a workflow. Free.",
        "verb": "PUT",
        "path": "/v1/workflows/{id}/draft",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id",
            "name",
            "workflow"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "description": {
              "type": "string"
            },
            "workflow": {
              "type": "object"
            }
          }
        },
        "options": {
          "id": {
            "method": "listWorkflows",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "getWorkflowDraft",
        "label": "Get Workflow Draft",
        "description": "Get the current draft for a workflow. Free.",
        "verb": "GET",
        "path": "/v1/workflows/{id}/draft",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "options": {
          "id": {
            "method": "listWorkflows",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "deleteWorkflowDraft",
        "label": "Delete Workflow Draft",
        "description": "Remove the draft for a workflow. Free.",
        "verb": "DELETE",
        "path": "/v1/workflows/{id}/draft",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            }
          }
        },
        "options": {
          "id": {
            "method": "listWorkflows",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "testWorkflow",
        "label": "Test Workflow",
        "description": "Trigger a test execution of a workflow. Returns a test_run_id you can poll via getWorkflowExecution. Optionally pass overrides for the trigger data.",
        "verb": "POST",
        "path": "/v1/workflows/{id}/test",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "overrides": {
              "type": "object",
              "description": "Override trigger data: author_url, text, likes, comments, post_url, date_posted, source, signal_type, severity"
            },
            "test_config": {
              "type": "object",
              "description": "{ mode, strict_data_validation, action_mocks }"
            }
          }
        },
        "options": {
          "id": {
            "method": "listWorkflows",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "listWorkflowExecutions",
        "label": "List Workflow Executions",
        "description": "Paginated execution logs for a workflow. Free.",
        "verb": "GET",
        "path": "/v1/workflows/{id}/executions",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "page": {
              "type": "string"
            },
            "page_size": {
              "type": "string"
            }
          }
        },
        "options": {
          "id": {
            "method": "listWorkflows",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "getWorkflowExecution",
        "label": "Get Workflow Execution",
        "description": "Get a single workflow execution log with ordered step details (input, output, mapped_output, errors). Free.",
        "verb": "GET",
        "path": "/v1/workflows/{id}/executions/{runId}",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "id",
            "runId"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "Workflow ID"
            },
            "runId": {
              "type": "string",
              "description": "Execution run ID"
            }
          }
        },
        "options": {
          "id": {
            "method": "listWorkflows",
            "itemsPath": "items",
            "labelKey": "name",
            "valueKey": "id",
            "sublabelKey": "status",
            "args": {
              "limit": 100
            }
          }
        }
      },
      {
        "id": "listIntegrations",
        "label": "List Connected Integrations",
        "description": "List all OAuth and API-key integrations connected to the workspace (Slack, HubSpot, Salesforce, Attio, Linear, Notion, Airtable, Google Sheets, Gmail, Instantly, Smartlead, HeyReach, LaGrowthMachine). Free.",
        "verb": "GET",
        "path": "/v1/integrations",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "integrationHealth",
        "label": "Check Integration Health",
        "description": "Validates OAuth token freshness for an integration. Optional crm-fields probe for HubSpot/Attio/Salesforce. Free.",
        "verb": "GET",
        "path": "/v1/integrations/{type}/health",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "type"
          ],
          "properties": {
            "type": {
              "type": "string",
              "description": "slack | hubspot | attio | salesforce | linear | notion | airtable | google_sheets | gmail"
            },
            "probe": {
              "type": "string",
              "description": "none | crm-fields"
            }
          }
        }
      },
      {
        "id": "listSlackChannels",
        "label": "List Slack Channels",
        "description": "List channels in the connected Slack workspace, optionally filtered. Free.",
        "verb": "GET",
        "path": "/v1/integrations/slack/channels",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "search": {
              "type": "string"
            },
            "member_only": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "listSlackUsers",
        "label": "List Slack Users",
        "description": "List users in the connected Slack workspace. Free.",
        "verb": "GET",
        "path": "/v1/integrations/slack/users",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "search": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "getCrmFields",
        "label": "Get CRM Fields",
        "description": "Get contacts + companies field schemas for HubSpot, Attio, or Salesforce. Free.",
        "verb": "GET",
        "path": "/v1/integrations/{type}/crm-fields",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "type"
          ],
          "properties": {
            "type": {
              "type": "string",
              "description": "hubspot | attio | salesforce"
            }
          }
        }
      },
      {
        "id": "getCrmFieldOptions",
        "label": "Get CRM Field Options (Attio)",
        "description": "Get select/multiselect options for an Attio field. Free.",
        "verb": "GET",
        "path": "/v1/integrations/crm-field-options",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "object_type",
            "field_slug"
          ],
          "properties": {
            "object_type": {
              "type": "string",
              "description": "contacts | companies"
            },
            "field_slug": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "listLinearTeams",
        "label": "List Linear Teams",
        "description": "List all Linear teams. Free.",
        "verb": "GET",
        "path": "/v1/integrations/linear/teams",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "listLinearUsers",
        "label": "List Linear Users",
        "description": "List Linear users, optionally filtered by team or search. Free.",
        "verb": "GET",
        "path": "/v1/integrations/linear/users",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "team_id": {
              "type": "string"
            },
            "search": {
              "type": "string"
            }
          }
        },
        "options": {
          "team_id": {
            "method": "listLinearTeams",
            "itemsPath": "teams",
            "labelKey": "name",
            "valueKey": "id"
          }
        }
      },
      {
        "id": "listLinearStates",
        "label": "List Linear Workflow States",
        "description": "Workflow states for a Linear team. Free.",
        "verb": "GET",
        "path": "/v1/integrations/linear/states",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "team_id"
          ],
          "properties": {
            "team_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "team_id": {
            "method": "listLinearTeams",
            "itemsPath": "teams",
            "labelKey": "name",
            "valueKey": "id"
          }
        }
      },
      {
        "id": "listNotionDatabases",
        "label": "List Notion Databases",
        "description": "List Notion databases, optionally filtered by title. Free.",
        "verb": "GET",
        "path": "/v1/integrations/notion/databases",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string"
            },
            "page_size": {
              "type": "string",
              "description": "1-100, default 100"
            }
          }
        }
      },
      {
        "id": "getNotionSchema",
        "label": "Get Notion Database Schema",
        "description": "Properties/schema for a Notion database. Free.",
        "verb": "GET",
        "path": "/v1/integrations/notion/databases/{database_id}/schema",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "database_id"
          ],
          "properties": {
            "database_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "database_id": {
            "method": "listNotionDatabases",
            "labelKey": "title",
            "valueKey": "id"
          }
        }
      },
      {
        "id": "listAirtableBases",
        "label": "List Airtable Bases",
        "description": "List all Airtable bases. Free.",
        "verb": "GET",
        "path": "/v1/integrations/airtable/bases",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "listAirtableTables",
        "label": "List Airtable Tables",
        "description": "List tables within an Airtable base. Free.",
        "verb": "GET",
        "path": "/v1/integrations/airtable/bases/{base_id}/tables",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "base_id"
          ],
          "properties": {
            "base_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "base_id": {
            "method": "listAirtableBases",
            "labelKey": "name",
            "valueKey": "id"
          }
        }
      },
      {
        "id": "getAirtableFields",
        "label": "Get Airtable Table Fields",
        "description": "Field/column definitions for an Airtable table. Free.",
        "verb": "GET",
        "path": "/v1/integrations/airtable/fields",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "base_id",
            "table_id"
          ],
          "properties": {
            "base_id": {
              "type": "string"
            },
            "table_id": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "listGoogleSheetsDocuments",
        "label": "List Google Sheets Documents",
        "description": "List Google Sheets spreadsheets. Free.",
        "verb": "GET",
        "path": "/v1/integrations/google-sheets/documents",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      },
      {
        "id": "listGoogleSheetsSheets",
        "label": "List Sheets in a Google Sheets Doc",
        "description": "List sheets/tabs within a Google Sheets spreadsheet. Free.",
        "verb": "GET",
        "path": "/v1/integrations/google-sheets/documents/{document_id}/sheets",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "document_id"
          ],
          "properties": {
            "document_id": {
              "type": "string"
            }
          }
        },
        "options": {
          "document_id": {
            "method": "listGoogleSheetsDocuments",
            "labelKey": "name",
            "valueKey": "id"
          }
        }
      },
      {
        "id": "getGoogleSheetsColumns",
        "label": "Get Google Sheets Columns",
        "description": "Column headers for a Google Sheets sheet. Free.",
        "verb": "GET",
        "path": "/v1/integrations/google-sheets/columns",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "document_id",
            "sheet_id"
          ],
          "properties": {
            "document_id": {
              "type": "string"
            },
            "sheet_id": {
              "type": "string"
            }
          }
        }
      },
      {
        "id": "listCampaigns",
        "label": "List Campaigns (Instantly / Smartleads / HeyReach)",
        "description": "List campaigns from the connected Instantly, Smartleads, or HeyReach integration. Free.",
        "verb": "GET",
        "path": "/v1/integrations/{type}/campaigns",
        "credits": 0,
        "input": {
          "type": "object",
          "required": [
            "type"
          ],
          "properties": {
            "type": {
              "type": "string",
              "description": "instantly | smartleads | heyreach"
            }
          }
        }
      },
      {
        "id": "listAudiences",
        "label": "List LaGrowthMachine Audiences",
        "description": "List LaGrowthMachine audiences. Free.",
        "verb": "GET",
        "path": "/v1/integrations/audiences",
        "credits": 0,
        "input": {
          "type": "object",
          "properties": {}
        }
      }
    ]
  }
];
