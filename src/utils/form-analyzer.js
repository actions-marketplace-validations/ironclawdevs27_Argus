/**
 * ARGUS Form Validation Analyzer (Sprint 5d — A11)
 *
 * Detects accessibility and security gaps in HTML forms — one of the most
 * commonly broken areas in web apps.
 *
 * Findings emitted:
 *   form_missing_required    — <input> inside a form with no required/aria-required
 *   form_no_autocomplete     — personal data field (name/email/address/CC) missing autocomplete
 *   form_inaccessible_error  — error element not linked via aria-describedby to its input
 *   form_unmasked_password   — <input type="text"> with password-adjacent label
 *   form_no_validation       — form with required fields and no novalidate + no JS validation
 *   form_summary             — info, always emitted
 */

import { registerExpensive } from '../registry.js';
import { unwrapEval }        from './mcp-client.js';
import { childLogger }       from './logger.js';

const logger = childLogger('form-analyzer');

const FORM_SCRIPT = `() => {
  var result = {
    missingRequired:   [],
    missingAutocomplete: [],
    inaccessibleErrors: [],
    unmaskedPasswords: [],
    noValidationForms: [],
  };

  // Personal data fields that should have autocomplete (WCAG 1.3.5)
  var PERSONAL_PATTERNS = /name|email|phone|tel|address|postcode|zip|city|country|credit|card|cc-|bday|birthday/i;
  var AUTOCOMPLETE_TYPES = /name|email|tel|address|on|off|username|current-password|new-password/i;

  var forms = Array.from(document.querySelectorAll('form'));

  for (var fi = 0; fi < forms.length; fi++) {
    var form = forms[fi];
    var inputs = Array.from(form.querySelectorAll('input,select,textarea'));
    var hasRequiredField = false;
    var hasJsValidation  = false;

    // Check for JS validation: submit event listener heuristic
    // We can't detect event listeners directly; check for novalidate + required combo
    var hasNovalidate = form.hasAttribute('novalidate');

    for (var ii = 0; ii < inputs.length; ii++) {
      var inp = inputs[ii];
      var type = (inp.type || 'text').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') continue;

      var name  = (inp.name || inp.id || inp.getAttribute('aria-label') || '').toLowerCase();
      var label = '';
      if (inp.id) {
        var lbl = document.querySelector('label[for="' + inp.id + '"]');
        if (lbl) label = lbl.textContent.trim().toLowerCase();
      }
      var combined = name + ' ' + label;

      // Missing required
      var hasRequired    = inp.required || inp.getAttribute('aria-required') === 'true';
      var isContentField = type !== 'checkbox' && type !== 'radio';
      if (!hasRequired && isContentField && combined.length > 0) {
        result.missingRequired.push({
          type: type,
          name: name.slice(0, 60),
          id:   (inp.id || '').slice(0, 60),
        });
      }

      if (inp.required) hasRequiredField = true;

      // Missing autocomplete on personal data fields
      var isPersonal = PERSONAL_PATTERNS.test(combined) && type !== 'checkbox' && type !== 'radio';
      if (isPersonal && !inp.getAttribute('autocomplete')) {
        result.missingAutocomplete.push({
          type: type,
          name: name.slice(0, 60),
          id:   (inp.id || '').slice(0, 60),
        });
      }

      // Unmasked password: type=text with password-adjacent label
      if (type === 'text' && /password|passwd|pwd/i.test(combined)) {
        result.unmaskedPasswords.push({
          name: name.slice(0, 60),
          id:   (inp.id || '').slice(0, 60),
        });
      }
    }

    // No validation: required fields but no novalidate and no submit handler evidence
    if (hasRequiredField && !hasNovalidate) {
      // Check for pattern attributes or min/max as proxy for validation intent
      var hasAttrValidation = Array.from(inputs).some(function(i) {
        return i.pattern || i.minLength > 0 || i.type === 'email' || i.type === 'url';
      });
      if (!hasAttrValidation) {
        result.noValidationForms.push({
          action: (form.action || '').slice(0, 100),
          id:     (form.id || '').slice(0, 60),
        });
      }
    }
  }

  // Inaccessible error messages: elements with error-like classes/roles not linked to input
  var errorEls = Array.from(document.querySelectorAll(
    '[role="alert"],[aria-live="assertive"],[aria-live="polite"],.error,.field-error,.form-error,.validation-error,.invalid-feedback'
  ));
  for (var ei = 0; ei < errorEls.length; ei++) {
    var el  = errorEls[ei];
    var eid = el.id;
    if (!eid) {
      result.inaccessibleErrors.push({
        tag:  el.tagName.toLowerCase(),
        text: el.textContent.trim().slice(0, 80),
        issue: 'no id — cannot be referenced by aria-describedby',
      });
      continue;
    }
    // Check if any input references this error via aria-describedby / aria-errormessage
    var linked = document.querySelector(
      '[aria-describedby~="' + eid + '"],[aria-errormessage="' + eid + '"]'
    );
    if (!linked) {
      result.inaccessibleErrors.push({
        tag:  el.tagName.toLowerCase(),
        id:   eid,
        text: el.textContent.trim().slice(0, 80),
        issue: 'has id but no input links to it via aria-describedby/aria-errormessage',
      });
    }
  }

  return JSON.stringify(result);
}`;

export async function analyzeForm(browser, url) {
  const findings = [];

  try {
    await browser.navigate(url);
    await browser.waitFor({ state: 'networkidle' }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
  } catch {
    return findings;
  }

  let data = null;
  try {
    const raw = await browser.evaluate(FORM_SCRIPT);
    const s   = unwrapEval(raw);
    data = typeof s === 'object' ? s : JSON.parse(s);
  } catch (err) {
    logger.warn(`[ARGUS] form-analyzer: failed for ${url}: ${err.message}`);
    data = { missingRequired: [], missingAutocomplete: [], inaccessibleErrors: [], unmaskedPasswords: [], noValidationForms: [] };
  }

  const missingRequired    = data.missingRequired    ?? [];
  const missingAutocomplete = data.missingAutocomplete ?? [];
  const inaccessibleErrors = data.inaccessibleErrors ?? [];
  const unmaskedPasswords  = data.unmaskedPasswords  ?? [];
  const noValidationForms  = data.noValidationForms  ?? [];

  // form_missing_required
  for (const inp of missingRequired.slice(0, 20)) {
    findings.push({
      type:     'form_missing_required',
      message:  `Form input '${inp.name || inp.id || inp.type}' has no required or aria-required attribute`,
      inputName: inp.name,
      inputType: inp.type,
      severity: 'warning',
      url,
    });
  }

  // form_no_autocomplete
  for (const inp of missingAutocomplete.slice(0, 20)) {
    findings.push({
      type:     'form_no_autocomplete',
      message:  `Personal data field '${inp.name || inp.id}' (type: ${inp.type}) is missing autocomplete attribute (WCAG 1.3.5)`,
      inputName: inp.name,
      inputType: inp.type,
      severity: 'warning',
      url,
    });
  }

  // form_inaccessible_error
  for (const err of inaccessibleErrors.slice(0, 10)) {
    findings.push({
      type:     'form_inaccessible_error',
      message:  `Error element not linked to its input via aria-describedby: ${err.issue}`,
      errorId:  err.id,
      errorText: err.text,
      severity: 'warning',
      url,
    });
  }

  // form_unmasked_password
  for (const inp of unmaskedPasswords.slice(0, 5)) {
    findings.push({
      type:     'form_unmasked_password',
      message:  `Input '${inp.name || inp.id}' has type="text" but is labelled as a password field — use type="password"`,
      inputName: inp.name,
      severity: 'critical',
      url,
    });
  }

  // form_no_validation
  for (const form of noValidationForms.slice(0, 5)) {
    findings.push({
      type:     'form_no_validation',
      message:  `Form (${form.id || form.action || 'unknown'}) has required fields but no HTML5 pattern/type or novalidate attribute — client-side validation may be absent`,
      formId:   form.id,
      severity: 'info',
      url,
    });
  }

  // Summary — always emitted
  const total = missingRequired.length + missingAutocomplete.length +
                inaccessibleErrors.length + unmaskedPasswords.length + noValidationForms.length;

  findings.push({
    type:             'form_summary',
    missingRequired:  missingRequired.length,
    missingAutocomplete: missingAutocomplete.length,
    inaccessibleErrors: inaccessibleErrors.length,
    unmaskedPasswords: unmaskedPasswords.length,
    noValidation:     noValidationForms.length,
    totalIssues:      total,
    message:          `Form: ${missingRequired.length} missing-required, ${missingAutocomplete.length} no-autocomplete, ${inaccessibleErrors.length} inaccessible-error, ${unmaskedPasswords.length} unmasked-pw, ${noValidationForms.length} no-validation`,
    severity:         'info',
    url,
  });

  return findings;
}

registerExpensive({
  name:    'form',
  analyze: (browser, url) => analyzeForm(browser, url),
});
