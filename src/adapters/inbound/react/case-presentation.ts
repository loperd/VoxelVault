import { createContext, useContext } from 'react';
import { ENDER_CASE, type CasePresentation } from '../../../config/cases.ts';

export const casePresentation = ENDER_CASE.presentation;
export const CasePresentationContext = createContext<CasePresentation>(casePresentation);
export function useCasePresentation(): CasePresentation {
  return useContext(CasePresentationContext);
}
