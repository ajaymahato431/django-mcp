/**
 * Curated Django guidance. Kept local (not fetched) so it is instant,
 * offline-safe, and stable — upstream has no equivalent machine-readable page.
 */

export const BEST_PRACTICES = {
  architecture: `## Architecture
- Prefer "fat models, thin views": put business logic on model methods, managers and querysets, not in views.
- Keep apps small, focused and reusable. A project is a collection of apps.
- Read secrets and environment-specific values from the environment, never from committed code.
- Split settings per environment (development, testing, production) rather than branching on \`DEBUG\`.
- Put reusable query logic on a custom \`QuerySet\` and expose it via \`Manager.from_queryset()\`.`,

  models: `## Models & database
- Use \`select_related()\` for forward foreign keys and \`prefetch_related()\` for reverse and many-to-many, to avoid N+1 queries.
- Do not use \`null=True\` on \`CharField\` or \`TextField\`; use \`blank=True\` so there is one representation of "empty".
- Index the fields you filter, order or join on, via \`db_index=True\` or \`Meta.indexes\`.
- Enforce invariants in the database with \`Meta.constraints\`, not only in \`clean()\`.
- Keep \`__str__\` cheap and side-effect free — never query inside it.
- Use \`bulk_create()\` and \`bulk_update()\` for large writes, and \`iterator()\` for large reads.`,

  views: `## Views & URLs
- Name every URL pattern and namespace them per app, then use \`reverse()\` and \`{% url %}\`.
- Use \`get_object_or_404()\` rather than catching \`DoesNotExist\` by hand.
- Prefer class-based views for standard CRUD, function-based views for simple or unusual logic. Avoid deep view inheritance either way.
- Do the work in \`form_valid()\` / \`post()\`, not in \`get_context_data()\`.
- Wrap multi-step writes in \`transaction.atomic()\`.`,

  templates: `## Templates
- Keep logic out of templates. Move anything non-trivial into the view, a model method, or a custom template tag or filter.
- Use \`{% url %}\` rather than hardcoding paths.
- Use template inheritance (\`{% extends %}\`, \`{% block %}\`) instead of repeating markup.
- Remember that Django autoescapes; reach for \`|safe\` or \`mark_safe\` only for content you control.`,

  forms: `## Forms
- Validate in forms and serializers, not in views.
- Use \`ModelForm\` when the form maps to a model, and set \`fields\` explicitly — never \`__all__\`.
- Put cross-field checks in \`clean()\`, single-field checks in \`clean_<field>()\`.`,

  security: `## Security
- Never run production with \`DEBUG = True\`, and never commit \`SECRET_KEY\`.
- Set \`ALLOWED_HOSTS\`, and enable \`SECURE_SSL_REDIRECT\`, \`SESSION_COOKIE_SECURE\` and \`CSRF_COOKIE_SECURE\` in production.
- Keep Django's CSRF protection on for all state-changing requests.
- Use the built-in authentication and permission framework rather than writing your own.
- Use the ORM or parameterised queries; if you must use \`raw()\` or \`extra()\`, never interpolate user input.
- Run \`manage.py check --deploy\` before shipping.`,

  performance: `## Performance
- Measure first: use \`django-debug-toolbar\` or \`QuerySet.explain()\` before optimising.
- Defer or restrict columns with \`only()\` and \`defer()\` when rows are wide.
- Use \`exists()\` instead of \`count()\` when you only need to know whether rows exist, and \`count()\` instead of \`len()\` on an unevaluated queryset.
- Cache expensive, stable computations; invalidate on write.
- Push aggregation into the database with \`annotate()\` and \`aggregate()\` rather than looping in Python.`,

  testing: `## Testing
- Prefer \`pytest-django\` or Django's \`TestCase\`, which wraps each test in a transaction.
- Build fixtures with factories rather than large JSON fixture files.
- Use \`assertNumQueries()\` to lock in the query count on hot paths.
- Test at the boundary you care about: models and forms directly, views through the test client.`,
};

export const ALL_TOPICS = Object.keys(BEST_PRACTICES);

export function renderBestPractices(topic) {
  if (topic) {
    const key = ALL_TOPICS.find((t) => t.toLowerCase() === String(topic).toLowerCase());
    if (key) return `# Django Best Practices — ${key}\n\n${BEST_PRACTICES[key]}`;
    return (
      `Unknown topic "${topic}". Available topics: ${ALL_TOPICS.join(", ")}.\n\n` +
      `# Django Best Practices\n\n${Object.values(BEST_PRACTICES).join("\n\n")}`
    );
  }
  return `# Django Best Practices\n\n${Object.values(BEST_PRACTICES).join("\n\n")}`;
}
