'use strict';

function readTlv(buffer,offset){
 if(!Buffer.isBuffer(buffer)||!Number.isInteger(offset)||offset<0||offset+2>buffer.length)throw Error('INVALID_DER');
 const tag=buffer[offset++];if((tag&0x1f)===0x1f)throw Error('INVALID_DER');
 const first=buffer[offset++];let length;
 if((first&0x80)===0)length=first;
 else{
  const count=first&0x7f;if(count<1||count>4||offset+count>buffer.length||buffer[offset]===0)throw Error('INVALID_DER');
  length=0;for(let i=0;i<count;i++)length=length*256+buffer[offset++];if(length<128)throw Error('INVALID_DER');
 }
 const start=offset,end=start+length;if(end>buffer.length||end<start)throw Error('INVALID_DER');return {tag,start,end,next:end};
}
function children(buffer,node){
 const out=[];let offset=node.start;while(offset<node.end){const child=readTlv(buffer,offset);if(child.next<=offset||child.end>node.end)throw Error('INVALID_DER');out.push(child);offset=child.next;}if(offset!==node.end)throw Error('INVALID_DER');return out;
}
function base128(value){
 if(!Number.isSafeInteger(value)||value<0)throw Error('INVALID_OID');const out=[value&0x7f];for(value=Math.floor(value/128);value;value=Math.floor(value/128))out.unshift((value&0x7f)|0x80);return out;
}
function oidValue(oid){
 if(typeof oid!=='string'||!/^(?:0|1|2)(?:\.\d+)+$/.test(oid))throw Error('INVALID_OID');const arcs=oid.split('.').map(Number);if(arcs.length<2||arcs.some(x=>!Number.isSafeInteger(x)||x<0)||arcs[0]<2&&arcs[1]>39)throw Error('INVALID_OID');const out=[];out.push(...base128(arcs[0]*40+arcs[1]));for(const arc of arcs.slice(2))out.push(...base128(arc));return Buffer.from(out);
}
function hasExtensionOid(der,oid){
 try{
  const cert=readTlv(der,0);if(cert.tag!==0x30||cert.next!==der.length)return false;const certParts=children(der,cert),tbs=certParts[0];if(!tbs||tbs.tag!==0x30)return false;
  const extensions=children(der,tbs).find(x=>x.tag===0xa3);if(!extensions)return false;const list=readTlv(der,extensions.start);if(list.tag!==0x30||list.next!==extensions.end)return false;
  const target=oidValue(oid);for(const extension of children(der,list)){if(extension.tag!==0x30)return false;const parts=children(der,extension),id=parts[0];if(!id||id.tag!==0x06)return false;if(der.subarray(id.start,id.end).equals(target))return true;}return false;
 }catch{return false;}
}
module.exports={hasExtensionOid};
