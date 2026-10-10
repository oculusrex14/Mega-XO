"""CPU shape/gradient/masking/reproducibility tests, not strength benchmarks."""
import unittest
import torch
from model import TinyPolicyValue, masked_loss

class ModelTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(2)
        torch.manual_seed(51)
    def test_shape_size_gradients_and_mask(self):
        model=TinyPolicyValue();parameters=sum(p.numel() for p in model.parameters())
        self.assertTrue(250000<=parameters<=2000000,parameters)
        x=torch.zeros(2,8,9,9);logits,value=model(x)
        self.assertEqual(tuple(logits.shape),(2,81));self.assertEqual(tuple(value.shape),(2,1));self.assertTrue(torch.all(value.abs()<=1))
        mask=torch.zeros(2,81,dtype=torch.bool);mask[:,[3,17]]=True;policy=mask.float()/2;outcome=torch.tensor([1.,-1.])
        pl,vl=masked_loss(logits,value,mask,policy,outcome);(pl+vl).backward()
        self.assertTrue(all(p.grad is not None and torch.isfinite(p.grad).all() for p in model.parameters()))
        self.assertEqual(len(model.action_to_spatial.unique()),81)
    def test_seeded_initialization_repeats(self):
        a=TinyPolicyValue();torch.manual_seed(51);b=TinyPolicyValue()
        self.assertTrue(all(torch.equal(v,b.state_dict()[k]) for k,v in a.state_dict().items()))
    def test_rejects_empty_mask(self):
        with self.assertRaises(ValueError):masked_loss(torch.zeros(1,81),torch.zeros(1,1),torch.zeros(1,81,dtype=torch.bool),torch.zeros(1,81),torch.zeros(1))
if __name__=='__main__': unittest.main()
