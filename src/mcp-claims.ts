// Call only after Supabase /auth/v1/user has verified the token signature.
export function validateMcpClaims(token:string,userId:string,issuer:string,resource:string,now=Date.now()/1000) {
 const parts=token.split('.');
 if(parts.length!==3)throw Error('Invalid connection');
 const c=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
 const audience=Array.isArray(c.aud)?c.aud:[c.aud];
 if(c.sub!==userId||c.iss!==issuer||!audience.includes(resource)||c.role!=='authenticated'||typeof c.exp!=='number'||c.exp<=now||!c.client_id||!c.session_id||typeof c.scope!=='string'||!c.scope.split(' ').includes('email'))throw Error('Reconnect Continuity');
 return c;
}
