{{- define "lab.name" -}}{{ .Release.Name }}-guardrail{{- end -}}
{{- define "lab.syncEnv" -}}
- name: SILO_TENANT
  value: {{ .Values.tenantId | quote }}
- name: CONTROL_PLANE_URL
  value: {{ .Values.controlPlaneUrl | quote }}
- name: SYNC_TOKEN
  valueFrom:
    secretKeyRef: {name: {{ .Values.existingSecret | quote }}, key: sync-token}
{{- end -}}
{{- define "lab.auditEnv" -}}
- name: LOCAL_AUDIT_DATABASE_URL
  valueFrom:
    secretKeyRef: {name: {{ .Values.existingSecret | quote }}, key: local-audit-database-url}
{{- end -}}
{{- define "lab.security" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: [ALL]
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
{{- end -}}
