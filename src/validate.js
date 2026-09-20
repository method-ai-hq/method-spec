import { configShape } from './document-validators.js';
import Ajv from 'ajv';
import { methodSchema } from './schema.js';

const ajv = new Ajv({ allErrors: true, strict: false, ownProperties: true });
ajv.addSchema(methodSchema, 'method');
const validateConfiguration = configShape;
export { own, fail, safeData, shape, dataSchema, outputSchema, resolve, typeAt, effectiveOutputs } from './semantics.js';
import { own, fail, safeData, dataSchema } from './semantics.js';
export function assertSchema(schema, value, label) {
  const validate = ajv.compile(schema);
  if (!validate(value)) fail(`${label}: ${ajv.errorsText(validate.errors)}`, 'invalid_output');
}
function validateDefs(definitions = {}) {
  for (const def of Object.values(definitions)) {
    const schema = dataSchema(def);
    if (own(def, 'default')) assertSchema(schema, def.default, 'Default');
  }
}
export function validateConfig(config) {
  safeData(config);
  if (!validateConfiguration(config)) fail(`Configuration: ${ajv.errorsText(validateConfiguration.errors)}`);
  for (const tool of Object.values(config.tools ?? {})) { validateDefs(tool.in); validateDefs(tool.out); }
  for (const profile of Object.values(config.runtimes ?? {})) if (profile.env?.includes('METHOD_OPERATION_ID')) fail('METHOD_OPERATION_ID is reserved for the executor');
  return config;
}
export { validateMethod } from './document.js';
